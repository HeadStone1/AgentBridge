# AgentBridge

[简体中文](README.md) | [English](README.en.md) | **Español** | [Guía de despliegue para agentes de IA](README.ai.md)

AgentBridge es un puente MCP local que permite que Claude Code y OpenAI Codex se hagan preguntas, respondan, reintenten, alcancen acuerdos y guarden el estado de cada conversación en una base de datos SQLite dentro del proyecto.

> Versión de desarrollo actual: v0.7.3. AgentBridge se registra globalmente una sola vez; cada sesión detecta el proyecto activo y guarda su base SQLite dentro de ese proyecto.

En Windows, el paquete MSIX unificado de ChatGPT Desktop no permite que procesos externos ejecuten su runtime privado de Codex. Por eso AgentBridge incluye la CLI oficial `@openai/codex` e inicia con ella un App Server stdio independiente; ejecuta `codex login` una vez con la misma cuenta de Windows si todavía no está autenticada.

> Verificación actual del código fuente: pasan la comprobación UTF-8, la compilación TypeScript y toda la suite automatizada, incluidas 30 conexiones MCP consecutivas con el SDK oficial. `auto/reuse` reanuda una sesión nativa dentro de la sesión de colaboración del proyecto; `fresh` crea una sala aislada y reutiliza su propia sesión en turnos posteriores. Estas pruebas automáticas no sustituyen la validación con proveedores reales: solo declare comunicación bidireccional después de llamadas `ask_peer` correctas de Claude → Codex y Codex → Claude.

## Instalación rápida

### Elija un solo método

| Situación | Método recomendado | Requisito |
|---|---|---|
| Usuario normal o usuario de Codex App | Paquete de GitHub Release | No requiere instalar Node.js aparte |
| Desarrollador que ya utiliza Node.js | Paquete npm global | Node.js 22.13+ |
| Colaborador que modifica AgentBridge | Código fuente | Git, npm y Node.js 22.13+ |

No mezcle comandos de Release, npm y código fuente. Los paquetes para usuarios están en [GitHub Releases](https://github.com/HeadStone1/AgentBridge/releases/latest).

### Requisitos previos

- Claude Code, Codex, AgentBridge y el proyecto deben estar en la misma máquina o en la misma máquina virtual. Una Codex App instalada en el anfitrión no puede ofrecer su App Server local a AgentBridge dentro de la VM invitada.
- Instale e inicie sesión en Claude Code. Claude Desktop por sí solo no es el proveedor Claude compatible.
- Instale e inicie sesión en Codex App o en Codex CLI independiente.
- Si usa Codex App, no necesita instalar Codex CLI por separado.
- Use una ruta absoluta, existente y escribible para el proyecto.

### Instalación desde GitHub Release

Descargue `SHA256SUMS.txt` y el paquete de su plataforma:

- Windows x64: `AgentBridge-v0.7.1-win32-x64.zip`
- Linux x64: `AgentBridge-v0.7.1-linux-x64.tar.gz`
- macOS Apple Silicon: `AgentBridge-v0.7.1-darwin-arm64.tar.gz`

Linux ARM64 y macOS Intel requieren actualmente npm o instalación desde el código fuente.

Windows PowerShell, después de verificar SHA-256 y extraer el ZIP:

```powershell
Unblock-File -LiteralPath '.\install.ps1'
powershell -ExecutionPolicy Bypass -File .\install.ps1
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" doctor
```

Linux/macOS, después de verificar y extraer el paquete:

```bash
chmod +x install.sh
./install.sh
~/.agentbridge/bin/agentbridge doctor
```

El instalador ejecuta `setup` y `doctor`, y muestra el lanzador permanente y el comando de desinstalación completa.

### Instalación con npm

El paquete es [`@headstone/agentbridge`](https://www.npmjs.com/package/@headstone/agentbridge).

```bash
node --version
npm install --global @headstone/agentbridge
agentbridge --version
agentbridge setup
agentbridge doctor
```

Use Node.js 22.13 o posterior. No se recomienda usar `npx` una sola vez para `setup`, porque la configuración MCP necesita una ruta estable al programa.

### Instalación desde el código fuente

```bash
git clone https://github.com/HeadStone1/AgentBridge.git
cd AgentBridge
npm ci
npm test
node packages/cli/dist/index.js setup
node packages/cli/dist/index.js doctor
```

Use este modo solo para desarrollo. Para una instalación independiente del código fuente, utilice GitHub Release.

## Comprobar Codex App o Codex CLI

Ejecute `doctor` y lea `providers.codexSelectedBackend`. No deduzca el backend solo porque la interfaz gráfica esté abierta.

Resultado esperado para Codex App:

```json
{
  "mode": "app-server",
  "source": "desktop"
}
```

Resultado esperado para Codex CLI independiente:

```json
{
  "mode": "cli",
  "source": "system"
}
```

`codexAppDetected` solamente indica que se observó el proceso de la interfaz. No demuestra que App Server pueda iniciarse. Para Codex App, `codexAppServer` debe ser verdadero y el backend seleccionado debe ser `app-server` con origen `desktop`.

## Registrar una vez y usar todos los proyectos

Ejecute `agentbridge setup` una sola vez. Crea una entrada de usuario en `~/.claude.json` y una entrada global en `~/.codex/config.toml`, sin fijar la ruta del proyecto, la base de datos ni `cwd`.

Después de reiniciar ambos clientes, abra cualquier proyecto. La primera herramienta de AgentBridge vincula ese proceso MCP al proyecto activo mediante el entorno de Claude, las raíces MCP o el directorio de trabajo del cliente, y crea `<proyecto>/.agentbridge/agentbridge.sqlite`. Los proyectos siguen aislados sin repetir `setup`. Si el cliente no proporciona un contexto seguro, pase la ruta absoluta `projectPath` en la primera llamada a `ask_peer` o `list_discussions`.

## Verificación completa en cuatro niveles

1. Ejecute `agentbridge doctor /ruta/absoluta`. Exija `ok: true`, todas las comprobaciones de instalación, proyecto, base de datos y configuración correctas, `providers.claudeCli: true` y el backend Codex solicitado.
2. Revise `~/.claude.json` y `~/.codex/config.toml`. Claude debe usar `AGENTBRIDGE_AGENT=claude`, Codex debe usar `AGENTBRIDGE_AGENT=codex`, y ninguna entrada global debe fijar `AGENTBRIDGE_PROJECT_PATH`, `AGENTBRIDGE_DB_PATH` ni `cwd`.
3. Reinicie ambos clientes y confirme que el servidor MCP `agentbridge` ofrece ocho herramientas: `ask_peer`, `reply_peer`, `get_discussion`, `wait_discussion`, `list_discussions`, `close_discussion`, `cancel_discussion` y `retry_discussion`.
4. Realice una llamada real Claude→Codex y otra Codex→Claude con `ask_peer`. Compruebe el registro mediante `agentbridge status /ruta/absoluta`.

`doctor` valida archivos, comandos y proveedores, pero no puede demostrar que una aplicación que ya estaba abierta haya recargado MCP. No declare éxito completo sin los pasos 3 y 4.

## Comandos principales

| Comando | Función |
|---|---|
| `setup [ruta]` | Configura globalmente ambos clientes; la ruta opcional solo preinicializa un proyecto |
| `doctor [ruta]` | Diagnostica instalación, proyecto, base de datos, configuración y proveedores |
| `status [ruta]` | Muestra sesiones, conversaciones y métricas |
| `cleanup [ruta] --older-than-days N [--yes]` | Previsualiza o elimina conversaciones finalizadas antiguas |
| `version` | Muestra la versión instalada |
| `update` | Busca una versión estable sin modificar archivos |
| `update --install` | Descarga, verifica e instala el último Release compatible |
| `rollback` | Vuelve a la versión Release instalada anteriormente |
| `uninstall [ruta] --yes` | Elimina los datos de un proyecto y conserva el registro MCP global |
| `uninstall-all --yes --remove-program` | Elimina todos los proyectos registrados y el programa Release/npm |

En Windows Release use `%USERPROFILE%\.agentbridge\bin\agentbridge.cmd`; en Linux/macOS use `~/.agentbridge/bin/agentbridge`.

## Actualización

Instalación Release:

```bash
agentbridge update
agentbridge update --install
agentbridge setup
agentbridge doctor
```

Instalación npm:

```bash
npm install --global @headstone/agentbridge@latest
agentbridge setup
agentbridge doctor
```

Reinicie los dos clientes después de actualizar. Las instalaciones Release guardan versiones anteriores y permiten `agentbridge rollback`.

## Flujo de discusión y retención

`setup` instala de forma segura cuatro Skills enfocadas para Claude Code y Codex: `agentbridge-collaboration`, `agentbridge-peer-review`, `agentbridge-debug` y `agentbridge-decision-debate`; nunca sobrescribe una Skill personalizada o modificada. Reutilice siempre el mismo `discussionId` y use `wait_discussion` cuando el envío esté `QUEUED` o `RUNNING`. `ask_peer.mode` admite `review`, `discussion` y `deep-discussion`, con límites predeterminados de 3, 12 y 20 respuestas correctas; `maxTurns` los sustituye como límite de seguridad.

SQLite conserva el historial indefinidamente por defecto. `cleanup` solo previsualiza salvo que se añada `--yes`, y únicamente elimina conversaciones `COMPLETED` o `CANCELLED`. `AGENTBRIDGE_DISCUSSION_RETENTION_DAYS=1..3650` activa la limpieza al iniciar. Las sesiones nativas se conservan salvo que `AGENTBRIDGE_ARCHIVE_SESSIONS_ON_CLOSE=1`; un proveedor sin archivado se omite sin impedir el cierre.

## Copia de seguridad y desinstalación

Detenga los dos clientes antes de copiar todo el directorio `<proyecto>/.agentbridge`. SQLite puede usar archivos `-wal` y `-shm`; no copie solamente el archivo principal mientras haya escrituras activas.

Eliminar un proyecto:

```bash
agentbridge uninstall /ruta/absoluta/del/proyecto --yes
```

El comando conserva el programa y los demás proyectos.

Desinstalación completa:

```bash
agentbridge uninstall-all --yes --remove-program
```

Elimina los proyectos registrados y la instalación Release/npm. Nunca elimina automáticamente un repositorio de código fuente.

## Problemas frecuentes

- `Cannot find module 'node:sqlite'`: actualice a Node.js 22.13+ o use el paquete Release.
- Codex App está abierta pero doctor elige CLI: la presencia de la interfaz no garantiza App Server; revise `codexSelectedBackend`, la instalación local y el inicio de sesión.
- La configuración existe pero no aparecen herramientas: cierre completamente ambos clientes, vuelva a abrirlos y revise sus errores de inicio MCP.
- Claude y Codex no ven las mismas conversaciones: confirme que ambos clientes abrieron la misma raíz absoluta del proyecto. Inicie una tarea o ventana nueva después de cambiar de proyecto; si no se detecta la raíz, pase el mismo `projectPath` absoluto en la primera llamada a `ask_peer` o `list_discussions`.
- El agente remoto es incorrecto: Claude requiere `AGENTBRIDGE_AGENT=claude` y Codex requiere `AGENTBRIDGE_AGENT=codex`.
- `database is locked`: mantenga SQLite en un disco local, detenga escritores activos y copie todo `.agentbridge` al hacer la copia de seguridad.
- `PEER_BUSY`: compruebe autenticación y salud del proveedor, espere a que termine el trabajo activo y use `retry_discussion`.
- PowerShell bloquea el script: primero valide SHA-256; después use `Unblock-File` y el comando Bypass documentado.
- `Permission denied` en Unix: aplique `chmod +x install.sh` al paquete ya verificado.
- Un segundo proyecto no muestra herramientas: `setup` global se ejecuta una sola vez. Reinicie completamente el cliente, abra el proyecto y revise los errores de inicio MCP; si la primera llamada no detecta la raíz, pase un `projectPath` absoluto.
- AgentBridge está dentro de una VM y Codex App solo en el anfitrión: instale Codex dentro de la VM o utilice una CLI autenticada dentro de la VM.

La matriz completa de diagnóstico para automatización está en [README.ai.md](README.ai.md). El manual chino completo se conserva en [README.md](README.md).

## Seguridad

AgentBridge no omite los permisos de Claude. Codex usa de forma predeterminada un sandbox de solo lectura. Las conversaciones se guardan sin cifrar en `.agentbridge/agentbridge.sqlite`; proteja el directorio según la sensibilidad del proyecto. No publique copias de configuración del proveedor, porque pueden contener variables o credenciales de otros MCP.

## Licencia

AgentBridge v0.5.0 y posteriores se distribuye como código fuente disponible bajo [PolyForm Noncommercial License 1.0.0](LICENSE). La licencia pública permite usos no comerciales, pero no concede uso comercial a terceros. Para cualquier uso comercial se necesita una licencia escrita independiente de HeadStone1; consulte [la guía comercial](COMMERCIAL_LICENSE.md).

Las versiones publicadas hasta v0.4.2 conservan Apache-2.0. Consulte el [historial de licencias](LICENSE_HISTORY.md). Los componentes de terceros mantienen sus propias licencias.
