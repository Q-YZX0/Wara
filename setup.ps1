# Muggi - Script de Despliegue EXCLUSIVO para Nodo (WaraNode) - PowerShell Version
$ErrorActionPreference = "Stop"

Write-Host "Iniciando configuracion de WaraNode..." -ForegroundColor Cyan

# 1. Configuracion de Modo (Interactivo)
# Si no existe archivo .env, lo creamos preguntando al usuario
if (!(Test-Path .env)) {
    Write-Host "-------------------------------------------------------" -ForegroundColor Yellow
    Write-Host "Configuracion Inicial de WaraNode:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Selecciona el modo de seguridad:"
    Write-Host "  1) LOCAL ONLY (Recomendado para PC Personal)"
    Write-Host "     - Solo accesible desde este ordenador."
    Write-Host "     - Maxima seguridad (Sin administracion remota)."
    Write-Host ""
    Write-Host "  2) REMOTE ENABLED (Para VPS/Servidores)"
    Write-Host "     - Permite control total desde tu Dashboard central."
    Write-Host "     - Genera una Admin Key segura."
    Write-Host ""
    
    $MODE_OPT = Read-Host "Opcion [1/2] (Default: 1 - Local Only)"
    
    $is_local = "true"
    if ($MODE_OPT -eq "2") {
        $is_local = "false"
    }
    
    # Puerto
    $INPUT_PORT = Read-Host "Puerto de WaraNode [21746]"
    if ([string]::IsNullOrWhiteSpace($INPUT_PORT)) {
        $PORT = "21746"
    }
    else {
        $PORT = $INPUT_PORT
    }
    
    # API Key TMDB
    Write-Host ""
    Write-Host "TMDB_API_KEY (Opcional):"
    Write-Host "  - Necesaria para autocompletar portadas y sinopsis."
    $TMDB_API_KEY = Read-Host "API Key [Vacio]"

    # RPC URL
    $DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com"
    
    Write-Host ""
    Write-Host "RPC_URL (Opcional/Publico):"
    Write-Host "  - URL del proveedor RPC (ej. https://sepolia.infura.io/v3/...)"
    Write-Host "  - Dejar en blanco para usar publico: $DEFAULT_RPC"
    $INPUT_RPC = Read-Host "RPC URL [Default: Publico]"
    
    $FinalRPC = $DEFAULT_RPC
    
    if (![string]::IsNullOrWhiteSpace($INPUT_RPC)) {
        $FinalRPC = $INPUT_RPC
    }
    elseif ($env:RPC_URL) { 
        $FinalRPC = $env:RPC_URL 
    }
    
    $RpcContent = "RPC_URL=$FinalRPC"

    # Escribir el archivo .env sin BOM para compatibilidad
    $EnvContent = @"
# WaraNode Configuration
DATABASE_URL=file:./dev.db
PORT=$PORT
LOCAL_ONLY=$is_local
$RpcContent
TMDB_API_KEY=$TMDB_API_KEY
"@
    [System.IO.File]::WriteAllText("$PWD/.env", $EnvContent)

    Write-Host "Configuracion guardada en .env" -ForegroundColor Green
    if ($is_local -eq "true") { Write-Host "   Modo: LOCAL ONLY" } else { Write-Host "   Modo: REMOTE ENABLED" }
    Write-Host "   Puerto: $PORT"
    if (![string]::IsNullOrEmpty($TMDB_API_KEY)) { Write-Host "   TMDB: OK" }
    
    if ($is_local -eq "false") {
        Write-Host "Nota: La Admin Key se generara automaticamente al iniciar el nodo" -ForegroundColor Yellow
        Write-Host "   y se guardara en 'wara_store/admin_key.secret'." -ForegroundColor Yellow
    }
}
else {
    Write-Host "Usando configuracion existente en .env" -ForegroundColor Blue
    Get-Content .env | ForEach-Object {
        if ($_ -match "LOCAL_ONLY=(.*)") { Write-Host "   Modo: LOCAL_ONLY=$($matches[1])" }
        if ($_ -match "PORT=(.*)") { Write-Host "   Port: $($matches[1])" }
    }
}

# 2. Instalacion de dependencias
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js no encontrado. Por favor instalalo manualmente." -ForegroundColor Red
    exit
}

Write-Host "Instalando dependencias del proyecto..." -ForegroundColor Yellow
npm install
npm run build

Write-Host "Inicializando Base de Datos..." -ForegroundColor Yellow
npx prisma generate
npx prisma db push

Write-Host "-------------------------------------------------------" -ForegroundColor Green
Write-Host "Configuracion de WaraNode completada." -ForegroundColor Green
Write-Host "-------------------------------------------------------"
