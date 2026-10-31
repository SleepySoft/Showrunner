' Showrunner 静默启动器（开机自启用，无控制台窗口）
' 自定位项目根目录（本文件在 scripts\ 下），优先使用便携版 Node.js
Set fso = CreateObject("Scripting.FileSystemObject")
Dim root : root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

Dim nodeExe : nodeExe = root & "\runtime\node\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")

Set sh = CreateObject("Wscript.Shell")
sh.CurrentDirectory = root
' 0 = 隐藏窗口；日志写入 data\server.log
sh.Run "cmd /c """"" & nodeExe & """" src\server.js >> data\server.log 2>&1""", 0, False
