using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine;

public sealed class HarnessReferenceEditorTests
{
    [Test]
    public void SavedReferenceSceneHasExactlyOneUsableBehaviour()
    {
        var scene = EditorSceneManager.OpenScene("Assets/Reference.unity", OpenSceneMode.Additive);
        try
        {
            int found = 0;
            foreach (GameObject root in scene.GetRootGameObjects())
            {
                foreach (MonoBehaviour behaviour in root.GetComponentsInChildren<MonoBehaviour>(true))
                {
                    Assert.That(behaviour, Is.Not.Null, "The saved scene contains a missing script");
                    if (behaviour.GetType().Name == "HarnessReference") found++;
                }
            }
            Assert.That(found, Is.EqualTo(1), "The built reference scene must contain the actual input behaviour");
        }
        finally { EditorSceneManager.CloseScene(scene, true); }
    }
}
