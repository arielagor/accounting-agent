@echo off
cd /d "C:\Users\ariel\.claude\projects\accounting-agent"
"C:\Program Files\nodejs\node.exe" --import tsx bin\close-agent.ts --mode=close >> "C:\Users\ariel\.claude\projects\accounting-agent\logs\task-MonthEndClose.log" 2>&1

