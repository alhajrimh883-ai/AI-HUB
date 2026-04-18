' AI-HUB - Silent Launcher
' Double-click to start. No CMD window.
' Use START.bat instead if you need to see console output.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir

' First run: install deps in a visible window
If Not fso.FolderExists(appDir & "\node_modules") Then
    shell.Run "cmd /c ""cd /d """ & appDir & """ && npm install && pause""", 1, True
End If

' Launch app silently (no CMD window)
shell.Run "cmd /c ""cd /d """ & appDir & """ && npm run dev""", 0, True
