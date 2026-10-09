// Explicit opt-in adapter. Copy into an approved project's Assets/Editor/HarnessUnityAdapter.cs.
// The runner never installs this file, creates scenes, edits packages, or guesses a Pipeline method.
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class HarnessUnityAdapter
{
    [Serializable]
    private sealed class Request
    {
        public int schemaVersion;
        public string jobId;
        public string operation;
        public string projectPath;
        public string editorVersion;
        public string readbackPath;
        public string outputPath;
        public string buildTarget;
        public string[] scenes;
        public string compressionFormat;
        public bool developmentBuild;
    }

    [Serializable]
    private sealed class Readback
    {
        public string jobId;
        public string operation;
        public string projectPath;
        public string editorVersion;
        public bool success;
        public string buildResult;
        public string buildTarget;
        public string outputPath;
        public int totalErrors;
    }

    public static void Execute()
    {
        string[] arguments = Environment.GetCommandLineArgs();
        int index = Array.IndexOf(arguments, "-harnessRequest");
        if (index < 0 || index + 1 >= arguments.Length)
            throw new ArgumentException("Missing -harnessRequest JSON file");
        Request request = JsonUtility.FromJson<Request>(File.ReadAllText(arguments[index + 1]));
        string project = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        StringComparison comparison = Application.platform == RuntimePlatform.WindowsEditor
            ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (request.schemaVersion != 1 || request.editorVersion != Application.unityVersion ||
            !string.Equals(Path.GetFullPath(request.projectPath), project, comparison))
            throw new InvalidOperationException("Harness request Editor/project identity mismatch");
        string jobDirectory = Path.Combine(project, ".harness", "unity-runtime", "jobs", request.jobId);
        if (!string.Equals(Path.GetFullPath(request.readbackPath), Path.Combine(jobDirectory, "readback.json"), comparison) ||
            !string.Equals(Path.GetFullPath(request.outputPath), Path.Combine(jobDirectory, "build"), comparison))
            throw new InvalidOperationException("Harness output paths must belong to this job");
        if (File.Exists(request.readbackPath))
            throw new InvalidOperationException("Refusing to overwrite an existing readback");
        var readback = new Readback {
            jobId = request.jobId, operation = request.operation, projectPath = project,
            editorVersion = Application.unityVersion, success = false
        };
        if (request.operation == "compile")
        {
            if (EditorApplication.isCompiling || EditorUtility.scriptCompilationFailed)
                throw new InvalidOperationException("Editor compilation has not completed successfully");
            readback.success = true;
        }
        else if (request.operation == "build")
        {
            if (request.buildTarget != "WebGL" || request.scenes == null || request.scenes.Length == 0)
                throw new InvalidOperationException("An explicit WebGL scene list is required");
            if (Directory.Exists(request.outputPath))
                throw new InvalidOperationException("Refusing to reuse an existing build directory");
            foreach (string scene in request.scenes)
            {
                if (!scene.StartsWith("Assets/", StringComparison.Ordinal) ||
                    !scene.EndsWith(".unity", StringComparison.Ordinal) ||
                    !File.Exists(Path.Combine(project, scene)))
                    throw new InvalidOperationException("Invalid build scene: " + scene);
            }
            WebGLCompressionFormat originalCompression = PlayerSettings.WebGL.compressionFormat;
            BuildReport report;
            try
            {
                if (!string.IsNullOrEmpty(request.compressionFormat))
                    PlayerSettings.WebGL.compressionFormat = (WebGLCompressionFormat)Enum.Parse(typeof(WebGLCompressionFormat), request.compressionFormat, false);
                report = BuildPipeline.BuildPlayer(new BuildPlayerOptions {
                    scenes = request.scenes, locationPathName = request.outputPath,
                    target = BuildTarget.WebGL,
                    options = request.developmentBuild ? BuildOptions.Development : BuildOptions.None
                });
            }
            finally { PlayerSettings.WebGL.compressionFormat = originalCompression; }
            readback.buildResult = report.summary.result.ToString();
            readback.buildTarget = report.summary.platform.ToString();
            readback.outputPath = report.summary.outputPath;
            readback.totalErrors = checked((int)report.summary.totalErrors);
            readback.success = report.summary.result == BuildResult.Succeeded && report.summary.totalErrors == 0;
        }
        else throw new InvalidOperationException("Adapter only supports compile or build");
        File.WriteAllText(request.readbackPath, JsonUtility.ToJson(readback, true));
        if (!readback.success) throw new InvalidOperationException("Harness Unity operation failed");
        Debug.Log("HARNESS_UNITY_COMPLETED:" + request.jobId + ":" + request.operation);
    }
}
