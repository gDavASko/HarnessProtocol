#!/usr/bin/env node
import fs from 'fs';
import vm from 'vm';

// ─── Headless render/loop oracle (рунг console_clean для behavioral-узлов) ───
// Прогоняет браузерный игровой/render-цикл БЕЗ экрана: стабирует canvas/DOM/
// requestAnimationFrame, запускает скрипт, «прокачивает» N кадров и ассертит
// ноль необработанных исключений и console.error. Ловит класс багов, что раньше
// отводился вслепую (waiver console_clean): краши в цикле, NaN-каскады, поломки
// на переходах уровней/поражении. Зависания (бесконечный цикл в кадре) ловятся
// таймаутом вызывающего валидатора. Визуальные баги — вне охвата (судит человек).
//
// CLI: node headlessLoop.mjs <file.html|file.js> [--frames 3000] [--fps 60]
//      [--no-input] [--json]
// Exit 0 — цикл прогнан чисто; exit 1 — исключение/ошибка/цикл не стартовал.

function parseArgs(argv) {
    const a = { file: argv[2], frames: 3000, fps: 60, input: true, json: false };
    for (let i = 3; i < argv.length; i++) {
        if (argv[i] === '--frames') a.frames = parseInt(argv[++i], 10) || 3000;
        else if (argv[i] === '--fps') a.fps = parseInt(argv[++i], 10) || 60;
        else if (argv[i] === '--no-input') a.input = false;
        else if (argv[i] === '--json') a.json = true;
    }
    return a;
}

function extractScript(file) {
    const raw = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
    if (/\.m?js$/i.test(file)) return raw;
    // HTML: склеиваем все inline <script> без src.
    const scripts = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(raw))) scripts.push(m[1]);
    if (!scripts.length) throw new Error('в файле нет inline <script>');
    return scripts.join('\n;\n');
}

function buildSandbox(state) {
    const noop = () => {};
    const ctx2d = new Proxy({}, {
        get(_t, p) {
            if (p === 'createRadialGradient' || p === 'createLinearGradient' || p === 'createPattern')
                return () => ({ addColorStop: noop });
            if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
            if (p === 'measureText') return () => ({ width: 0 });
            return noop;
        },
        set() { return true; }
    });

    const elements = state.elements;
    function makeEl(id) {
        const el = {
            id, textContent: '', value: '', _handlers: {}, _onclick: null,
            style: new Proxy({ cssText: '' }, { get(t, p) { return t[p] ?? ''; }, set(t, p, v) { t[p] = v; return true; } }),
            classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
            width: 0, height: 0,
            addEventListener(type, fn) { this._handlers[type] = fn; },
            removeEventListener() {},
            set onclick(fn) { this._onclick = fn; },
            get onclick() { return this._onclick; },
            appendChild(c) { return c; }, removeChild: noop, setAttribute: noop, getAttribute: () => null,
            getContext: () => ctx2d,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: state.W, height: state.H, right: state.W, bottom: state.H }),
            focus: noop, requestPointerLock: noop
        };
        elements.push(el);
        return el;
    }

    const byId = new Map();
    const documentStub = {
        getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl(id)); return byId.get(id); },
        querySelector: () => makeEl('q'), querySelectorAll: () => [],
        createElement: () => makeEl('new'),
        addEventListener(type, fn) { state.winHandlers[type] = fn; },
        removeEventListener: noop,
        get body() { if (!byId.has('__body')) byId.set('__body', makeEl('__body')); return byId.get('__body'); },
        documentElement: { style: {}, setAttribute: noop }
    };

    const windowStub = {
        innerWidth: state.W, innerHeight: state.H, devicePixelRatio: 1,
        addEventListener(type, fn) { state.winHandlers[type] = fn; },
        removeEventListener: noop,
        requestAnimationFrame(cb) { state.rafQueue.push(cb); return state.rafQueue.length; },
        cancelAnimationFrame: noop,
        setTimeout: (fn) => { state.timeouts.push(fn); return 0; }, clearTimeout: noop,
        setInterval: () => 0, clearInterval: noop,
        performance: { now: () => state.clock },
        matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
        getComputedStyle: () => ({ getPropertyValue: () => '' })
    };

    const consoleStub = {
        log: noop, info: noop, debug: noop, warn: noop,
        error: (...args) => { state.consoleErrors.push(args.map(String).join(' ').slice(0, 300)); }
    };

    const sandbox = {
        document: documentStub, window: windowStub, console: consoleStub,
        requestAnimationFrame: windowStub.requestAnimationFrame,
        cancelAnimationFrame: noop,
        performance: windowStub.performance,
        setTimeout: windowStub.setTimeout, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
        Math, Date, JSON, Object, Array, Number, String, Boolean, Symbol, Map, Set, WeakMap, WeakSet,
        Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Int32Array, ArrayBuffer,
        isNaN, isFinite, parseInt, parseFloat, RegExp, Error, TypeError, RangeError, Promise
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    return sandbox;
}

function main() {
    const args = parseArgs(process.argv);
    if (!args.file) {
        console.error(JSON.stringify({ error: 'Использование: node headlessLoop.mjs <file.html|file.js> [--frames N]' }));
        process.exit(2);
    }

    const state = {
        W: 900, H: 700, clock: 0, rafQueue: [], timeouts: [],
        elements: [], winHandlers: {}, consoleErrors: []
    };
    let code;
    try { code = extractScript(args.file); } catch (e) {
        console.error(JSON.stringify({ error: `не удалось прочитать скрипт: ${e.message}` })); process.exit(2);
    }

    const sandbox = buildSandbox(state);
    vm.createContext(sandbox);

    const fail = (stage, msg) => {
        console.log(JSON.stringify({
            ok: false, stage, error: String(msg).slice(0, 600),
            frames_run: state.framesRun || 0, console_errors: state.consoleErrors.slice(0, 5)
        }, null, 2));
        process.exit(1);
    };

    // 1) загрузка скрипта
    try { vm.runInContext(code, sandbox, { filename: args.file, timeout: 5000 }); }
    catch (e) { fail('load', e && e.stack || e); }

    // 2) старт: дёргаем onclick всех кнопок (обычно старт игры) + click-хендлеры
    const fireStart = () => {
        for (const el of state.elements) {
            try { if (typeof el._onclick === 'function') el._onclick({ button: 0, preventDefault() {} }); } catch (e) { fail('start', e && e.stack || e); }
            const ch = el._handlers && el._handlers.click;
            try { if (typeof ch === 'function') ch({ button: 0, preventDefault() {} }); } catch (e) { fail('start', e && e.stack || e); }
        }
    };
    fireStart();

    if (state.rafQueue.length === 0) {
        // цикл не зарегистрировал ни одного requestAnimationFrame → он не запустился
        fail('no-loop', 'скрипт не вызвал requestAnimationFrame — игровой цикл не стартовал (нет анимационного контура)');
    }

    // 3) прокачка кадров
    const canvas = state.elements.find(e => e.id === 'c') || state.elements.find(e => e._handlers && (e._handlers.mousedown || e._handlers.click));
    const dtms = 1000 / args.fps;
    let framesRun = 0;
    for (let f = 0; f < args.frames; f++) {
        state.clock += dtms;
        const q = state.rafQueue; state.rafQueue = [];
        if (q.length === 0) break; // цикл сам себя не перезапросил (мог закончиться штатно)
        for (const cb of q) {
            try { cb(state.clock); }
            catch (e) { state.framesRun = framesRun; fail('frame', e && e.stack || e); }
        }
        // ввод: периодически «стреляем» через canvas
        if (args.input && canvas && f % 11 === 3) {
            const h = canvas._handlers && (canvas._handlers.mousedown || canvas._handlers.pointerdown || canvas._handlers.click);
            if (typeof h === 'function') {
                try { h({ button: 0, clientX: 20 + (f * 37) % state.W, clientY: 20 + (f * 53) % state.H, preventDefault() {}, touches: null }); }
                catch (e) { state.framesRun = framesRun; fail('input', e && e.stack || e); }
            }
        }
        framesRun++;
    }

    if (state.consoleErrors.length) {
        state.framesRun = framesRun;
        fail('console-error', `console.error во время прогона: ${state.consoleErrors[0]}`);
    }

    console.log(JSON.stringify({
        ok: true, file: args.file, frames_run: framesRun, requested: args.frames,
        message: `Цикл прогнан ${framesRun} кадров без исключений и console.error.`
    }, null, 2));
    process.exit(0);
}

main();
