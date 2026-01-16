#!/bin/bash

# Muggi - Script de Despliegue EXCLUSIVO para Nodo (WaraNode)
set -e

echo "🚀 Iniciando configuración de WaraNode..."

# 1. Configuración de Modo (Interactivo)
# Si no existe archivo .env, lo creamos preguntando al usuario
if [ ! -f .env ]; then
    echo "-------------------------------------------------------"
    echo "⚠️  Configuración Inicial de WaraNode:"
    echo ""
    echo "Selecciona el modo de seguridad:"
    echo "  1) LOCAL ONLY (Recomendado para PC Personal)"
    echo "     - Solo accesible desde este ordenador."
    echo "     - Máxima seguridad (Sin administración remota)."
    echo ""
    echo "  2) REMOTE ENABLED (Para VPS/Servidores)"
    echo "     - Permite control total desde tu Dashboard central."
    echo "     - Genera una Admin Key segura."
    echo ""
    read -p "Opción [1/2] (Default: 1 - Local Only): " MODE_OPT

    is_local="true"
    if [ "$MODE_OPT" == "2" ]; then
        is_local="false"
    fi
    
    # Puerto
    read -p "Puerto de WaraNode [21746]: " INPUT_PORT
    PORT=${INPUT_PORT:-21746}
    
    # API Key TMDB
    echo ""
    echo "TMDB_API_KEY (Opcional):"
    echo "  - Necesaria para autocompletar portadas y sinopsis."
    read -p "API Key [Vacio]: " TMDB_API_KEY

    # Escribir el archivo .env completo
    cat <<EOF > .env
# WaraNode Configuration
DATABASE_URL=file:./dev.db
PORT=$PORT
LOCAL_ONLY=$is_local
RPC_URL=$RPC_URL
TMDB_API_KEY=$TMDB_API_KEY
EOF

    echo "✅ Configuración guardada en .env"
    echo "   Modo: $( [ "$is_local" == "true" ] && echo 'LOCAL ONLY' || echo 'REMOTE ENABLED' )"
    echo "   Puerto: $PORT"
    echo "   RPC: $RPC_URL"
    if [ ! -z "$TMDB_API_KEY" ]; then echo "   TMDB: OK"; fi
    if [ "$is_local" == "false" ]; then
        echo "🔐 Nota: La Admin Key se generará automáticamente al iniciar el nodo"
        echo "   y se guardará en 'wara_store/admin_key.secret'."
    fi
else
    echo "ℹ️  Usando configuración existente en .env"
    export $(grep -v '^#' .env | xargs)
    echo "   Modo: LOCAL_ONLY=$LOCAL_ONLY"
    echo "   Port: $PORT"
fi

# 2. Instalación de dependencias (Node.js + Paquetes)
if ! command -v node &> /dev/null; then
    echo "📦 Instalando Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs build-essential
fi

if ! command -v pm2 &> /dev/null; then
    echo "📦 Instalando PM2..."
    sudo npm install -g pm2
fi

echo "📦 Instalando dependencias del proyecto..."
npm install
npm run build

# 3. Configurar PM2 con las variables del .env
echo "🔥 Lanzando proceso..."

# PM2 soporta cargar variables desde archivo .env directamente con --env
pm2 delete wara-node 2>/dev/null || true # Borrar anterior si existe para recargar config
pm2 start dist/server.js --name "wara-node" --env .env

pm2 save
pm2 startup | tail -n 1 > /tmp/pm2_startup 
# (Opcional: ejecutar automáticamente el comando de startup si tenemos permisos, pero es arriesgado en script)

echo "-------------------------------------------------------"
echo "✅ WaraNode está corriendo."
echo "   Estado: pm2 status"
echo "   Logs:   pm2 logs wara-node"
echo "-------------------------------------------------------"
