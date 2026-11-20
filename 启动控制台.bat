
where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE=node"
) else (
  set "NODE=C:\Users\15975\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
)


"%NODE%" server.js
pause
