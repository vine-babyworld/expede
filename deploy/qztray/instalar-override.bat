@echo off
setlocal
title Instalar certificado EXPEDE no QZ Tray

REM ---------------------------------------------------------------
REM Instala o certificado raiz do EXPEDE (override.crt) no QZ Tray.
REM
REM Sem isso o QZ Tray trata a assinatura do EXPEDE como "untrusted"
REM e bloqueia a caixa "Lembrar minha decisao" -- obrigando a clicar
REM em Allow a cada impressao. Com o certificado instalado nenhuma
REM janela aparece.
REM
REM Rodar como ADMINISTRADOR (botao direito > Executar como admin).
REM Testado no QZ Tray 2.2.6.
REM ---------------------------------------------------------------

net session >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Rode este arquivo como ADMINISTRADOR.
    echo        Botao direito no arquivo ^> "Executar como administrador".
    goto :fim
)

set "QZDIR=%ProgramFiles%\QZ Tray"
if not exist "%QZDIR%\qz-tray.jar" set "QZDIR=%ProgramFiles(x86)%\QZ Tray"

if not exist "%QZDIR%\qz-tray.jar" (
    echo [ERRO] QZ Tray nao encontrado. Instale o QZ Tray antes de rodar este script.
    goto :fim
)
if not exist "%~dp0override.crt" (
    echo [ERRO] override.crt nao esta na mesma pasta deste .bat.
    goto :fim
)

echo QZ Tray encontrado em: %QZDIR%
echo.

echo [1/3] Encerrando o QZ Tray...
REM O QZ Tray roda como javaw.exe do runtime proprio, nao como qz-tray.exe.
REM Filtra pela linha de comando para nao matar outros processos Java da maquina.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*QZ Tray*' -and $_.Name -match 'javaw|java.exe|qz-tray' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 3 /nobreak >nul

echo [2/3] Copiando override.crt...
copy /y "%~dp0override.crt" "%QZDIR%\override.crt" >nul
if errorlevel 1 (
    echo [ERRO] Falha ao copiar o certificado.
    goto :fim
)

echo [3/3] Reiniciando o QZ Tray...
start "" "%QZDIR%\qz-tray.exe"
timeout /t 12 /nobreak >nul

echo.
echo --- Verificacao (procurando "CN=EXPEDE" no log do QZ Tray) ---
findstr /c:"Adding CA certificate: CN=EXPEDE" "%APPDATA%\qz\debug.log" >nul 2>&1
if errorlevel 1 (
    echo [ATENCAO] Nao encontrei a confirmacao no log.
    echo           Abra %APPDATA%\qz\debug.log e procure por "CN=EXPEDE".
) else (
    echo [OK] Certificado EXPEDE carregado como CA confiavel.
    echo.
    echo Recarregue o EXPEDE no navegador. A janela de "Allow" nao
    echo deve mais aparecer ao imprimir.
)

:fim
echo.
pause
endlocal
