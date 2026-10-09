using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class HarnessReferenceSetup
{
    public static void Execute()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
        new GameObject("Harness Reference").AddComponent<HarnessReference>();
        EditorSceneManager.SaveScene(scene, "Assets/Reference.unity");
        PlayerSettings.companyName = "HarnessProtocol";
        PlayerSettings.productName = "Technical Reference";
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
        PlayerSettings.WebGL.template = "APPLICATION:Minimal";
        AssetDatabase.SaveAssets();
        HarnessUnityAdapter.Execute();
    }
}
