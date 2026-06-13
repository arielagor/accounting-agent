@echo off
cd /d "C:\Users\ariel\.claude\projects\accounting-agent"
"C:\Program Files\nodejs\node.exe" --import tsx bin\sync.ts >> "C:\Users\ariel\.claude\projects\accounting-agent\logs\task-NightlySync.log" 2>&1

