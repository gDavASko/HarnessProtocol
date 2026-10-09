using System.Runtime.InteropServices;
using UnityEngine;

// A tooling reference: a real input changes state, survives reload, and reports
// observable state from the player. It is not a game or a performance benchmark.
public sealed class HarnessReference : MonoBehaviour
{
    public const string SaveKey = "harness-reference-counter";
    private int count;
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] private static extern void HarnessReportState(int count);
#endif
    private void Start()
    {
        count = PlayerPrefs.GetInt(SaveKey, 0);
        Report();
    }
    private void OnGUI()
    {
        GUI.skin.button.fontSize = 24;
        if (GUI.Button(new Rect(Screen.width / 2f - 150, Screen.height / 2f - 50, 300, 100), "Counter: " + count))
        {
            count++;
            PlayerPrefs.SetInt(SaveKey, count);
            PlayerPrefs.Save();
            Report();
        }
    }
    private void Report()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        HarnessReportState(count);
#endif
        Debug.Log("HARNESS_REFERENCE_STATE:" + count);
    }
}
