1. IdentityService.init()
   ├─ Carga node_identity.json
   ├─ Detecta IP pública (UPnP)
   ├─ Ejecuta benchmark de red
   └─ Detecta región geográfica
2. BlockchainService.init()
   ├─ Conecta a RPC (con failover)
   ├─ Inicializa contratos
   └─ Verifica conexión
3. P2PService.init()
   ├─ Carga peers conocidos
   ├─ Bootstrap desde Sentinel
   ├─ Inicia heartbeat
   └─ Inicia gossip protocol
4. CatalogService.init()
   ├─ Escanea contenido local
   ├─ Registra links
   └─ Inicia GC de temp
5. MediaService.init()
   ├─ Inicia blockchain sync
   ├─ Inicia governance jobs
   └─ Inicia Sentinel monitoring
6. AdService.init()
   ├─ Carga estado de sync
   ├─ Inicia polling blockchain
   └─ Inicia GC de ads
7. Express Server
   └─ Escucha en puerto 21746