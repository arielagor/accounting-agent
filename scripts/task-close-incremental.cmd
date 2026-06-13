@echo off
cd /d "C:\Users\ariel\.claude\projects\accounting-agent"
"C:\Program Files\nodejs\node.exe" --import tsx bin\close-agent.ts --mode=incremental >> "C:\Users\ariel\.claude\projects\accounting-agent\logs\task-CloseIncremental.log" 2>&1

