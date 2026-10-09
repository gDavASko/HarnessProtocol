mergeInto(LibraryManager.library, {
    HarnessReportState: function(count) {
        window.__harnessUnityState = { ready: true, count: count };
    }
});
