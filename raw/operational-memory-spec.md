# L1 Operational Memory Spec

## SYSTEM GUIDE: Rules for maintaining process operational memory

> 🔄 **Implementation (v2):** L1 `op_*.json` files are created by the autonomous
> strategy engine (`strategyEngine`) for nodes with `artifact_kind=text`; for
> `code` nodes the result is written by the IDE agent directly into the working
> tree. Trivial nodes do not create L1. See
> [current-implementation.md](current-implementation.md).

### 1. Role and context
You are an autonomous AI solver working inside the Harness environment. Your operational memory is isolated. You must record the progress of the local task in a dedicated operational document in **JSON** format.

This file is read by you on subsequent steps, by other agents, by automatic validation scripts, and by the human developer.

---

### 2. Main filling laws (cleanliness rules)
* **No textual garbage:** any human-style musings, hesitations, or reflections in text form are forbidden (e.g. *"I think we should try..."*, *"Oops, that failed, fixing now..."*). Your thinking (Chain of Thought) happens in your hidden context; only dry facts go into the JSON.
* **Record strictly after the fact (post-factum):** every iteration is recorded only after the action has been performed and a measurable result obtained.
* **No schema distortion:** the structure of keys, data types, and ENUM values must match the Specification 100%. Any deviation will block task execution by the backend.

---

### 3. Block filling instructions

#### `meta` block
Filled once at task start.
Pick the `domain` value strictly from the allowed list: `development`, `science`, `creative`, `design`.

#### `setup` block
Filled once at start.
`definition_of_done` must contain only verifiable, atomic success criteria (no vagueness).

#### `iterations` block (dynamic micro-step journal)
Every action is a new array element. Do not overwrite old iterations. If a step failed, record it with status `FAIL` and move to the next step.
* `action`: write strictly in past tense, short and to the point. Example: *"Changed the DB schema data type from INT to BIGINT"*.
* `error_message`: copying huge error logs is forbidden. Extract only the root cause from the log (exception name + code line). Maximum 150 characters. If the status is `SUCCESS`, this field is strictly `null`.
* `iteration_output`: a mandatory field for successful steps. Put the intermediate artifact here (code, calculation, text draft, prompt) so that on a failure at the next step the system can roll you back to this point.

#### `result` block
Filled exactly once, when you finish the local task.
* If you fulfilled every item of `definition_of_done`, set `status: "COMPLETED"`.
* If you exhausted the attempt limit (up to 5–10 steps), got stuck in a loop, or hit an unsolvable logical dead end, set `status: "BLOCKED"`.
* `tactical_insight`: describe the key conclusion or extracted lesson in 1–2 sentences. This field goes to the human and the Tactical manager. Example: *"Library X version 2.0 does not support asynchronous Y calls, so a synchronous wrapper was written"*.
* `marker`: your very last token in the file must be the string `"marker": "EndOfDecision"`. The automation uses it to detect that you are done.

---

### 4. Reference generation example

```json
{
  "meta": {
    "task_id": "TASK-771",
    "domain": "development",
    "agent_name": "coder_agent_v3",
    "timestamp_start": "2026-06-26T14:20:00Z"
  },
  "setup": {
    "goal": "Write an email validation function with Cyrillic domain support",
    "definition_of_done": [
      "The function validates tests with Latin-script emails",
      "The function successfully validates emails like тест@домен.рф",
      "The function rejects malformed addresses (no @, no domain)"
    ],
    "constraints": ["Implementation file: src/utils/validators.py"]
  },
  "iterations": [
    {
      "step": 1,
      "action": "Implemented a standard regex via the re module",
      "status": "FAIL",
      "error_type": "AssertionError",
      "error_message": "The test with the Cyrillic '.рф' domain returned False instead of True",
      "iteration_output": null
    },
    {
      "step": 2,
      "action": "Added the re.UNICODE flag and updated the regular expression in validators.py",
      "status": "SUCCESS",
      "error_type": null,
      "error_message": null,
      "iteration_output": {
        "function_name": "validate_email_v2",
        "regex_used": "^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+$",
        "loc": 8
      }
    }
  ],
  "result": {
    "status": "COMPLETED",
    "tactical_insight": "Python's standard re module requires explicit flags or punycode support to correctly validate Cyrillic TLDs.",
    "output_data": {
      "file_path": "src/utils/validators.py",
      "tests_passed": 3
    },
    "marker": "EndOfDecision"
  }
}
```
