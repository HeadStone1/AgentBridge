# AgentBridge

[简体中文](README.md) | [English](README.en.md) | **Español** | [Guía de despliegue para agentes de IA](README.ai.md)

AgentBridge es un puente MCP local que permite que Claude Code y OpenAI Codex se hagan preguntas, respondan, reintenten, alcancen acuerdos y guarden el estado de cada conversación en una base de datos SQLite dentro del proyecto.

> Versión de desarrollo actual: v0.5.0. Los paquetes recomendados de GitHub Release incluyen Node.js y se instalan en el directorio del usuario. Después de instalarlos no dependen del archivo descargado ni del repositorio de código fuente.

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

- Windows x64: `AgentBridge-v0.5.0-win32-x64.zip`
- Linux x64: `AgentBridge-v0.5.0-linux-x64.tar.gz`
- macOS Apple Silicon: `AgentBridge-v0.5.0-darwin-arm64.tar.gz`

Linux ARM64 y macOS Intel requieren actualmente npm o instalación desde el código fuente.

Windows PowerShell, después de verificar SHA-256 y extraer el ZIP:

```powershell
$project = 'C:\ruta\absoluta\del\proyecto'
if (-not (Test-Path -LiteralPath $project -PathType Container)) { throw 'El proyecto no existe' }
Unblock-File -LiteralPath '.\install.ps1'
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProjectPath $project
& "$env:USERPROFILE\.agentbridge\bin\agentbridge.cmd" doctor $project
```

Linux/macOS, después de verificar y extraer el paquete:

```bash
chmod +x install.sh
./install.sh /ruta/absoluta/del/proyecto
~/.agentbridge/bin/agentbridge doctor /ruta/absoluta/del/proyecto
```

El instalador ejecuta `setup` y `doctor`, y muestra el lanzador permanente y el comando de desinstalación completa.

### Instalación con npm

El paquete es [`@headstone/agentbridge`](https://www.npmjs.com/package/@headstone/agentbridge).

```bash
node --version
npm install --global @headstone/agentbridge
agentbridge --version
agentbridge setup /ruta/absoluta/del/proyecto
agentbridge doctor /ruta/absoluta/del/proyecto
```

Use Node.js 22.13 o posterior. No se recomienda usar `npx` una sola vez para `setup`, porque la configuración MCP necesita una ruta estable al programa.

### Instalación desde el código fuente

```bash
git clone https://github.com/HeadStone1/AgentBridge.git
cd AgentBridge
npm ci
npm test
node packages/cli/dist/index.js setup /ruta/absoluta/del/proyecto
node packages/cli/dist/index.js doctor /ruta/absoluta/del/proyecto
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

## Configurar cada proyecto

Cada proyecto tiene su propia configuración y base de datos. Ejecute `setup` para cada uno:

```bash
agentbridge setup /ruta/proyecto-a
agentbridge setup /ruta/proyecto-b
```

La configuración de Codex se guarda en `<proyecto>/.codex/config.toml`, la entrada de Claude se guarda en el ámbito de la ruta absoluta dentro de `~/.claude.json`, y los datos se guardan en `<proyecto>/.agentbridge`. Cierre completamente y vuelva a abrir Claude Code y Codex después de cambiar la configuración.

## Verificación completa en cuatro niveles

1. Ejecute `agentbridge doctor /ruta/absoluta`. Exija `ok: true`, todas las comprobaciones de instalación, proyecto, base de datos y configuración correctas, `providers.claudeCli: true` y el backend Codex solicitado.
2. Revise `~/.claude.json` y `<proyecto>/.codex/config.toml`. Claude debe usar `AGENTBRIDGE_AGENT=claude`, Codex debe usar `AGENTBRIDGE_AGENT=codex` y ambos deben apuntar al mismo `AGENTBRIDGE_DB_PATH` absoluto.
3. Reinicie ambos clientes y confirme que el servidor MCP `agentbridge` ofrece siete herramientas: `ask_peer`, `reply_peer`, `get_discussion`, `list_discussions`, `close_discussion`, `cancel_discussion` y `retry_discussion`.
4. Realice una llamada real Claude→Codex y otra Codex→Claude con `ask_peer`. Compruebe el registro mediante `agentbridge status /ruta/absoluta`.

`doctor` valida archivos, comandos y proveedores, pero no puede demostrar que una aplicación que ya estaba abierta haya recargado MCP. No declare éxito completo sin los pasos 3 y 4.

## Comandos principales

| Comando | Función |
|---|---|
| `setup [ruta]` | Inicializa un proyecto y configura los dos clientes MCP |
| `doctor [ruta]` | Diagnostica instalación, proyecto, base de datos, configuración y proveedores |
| `status [ruta]` | Muestra sesiones, conversaciones y métricas |
| `version` | Muestra la versión instalada |
| `update` | Busca una versión estable sin modificar archivos |
| `update --install` | Descarga, verifica e instala el último Release compatible |
| `rollback` | Vuelve a la versión Release instalada anteriormente |
| `uninstall [ruta] --yes` | Elimina la configuración y los datos de un proyecto |
| `uninstall-all --yes --remove-program` | Elimina todos los proyectos registrados y el programa Release/npm |

En Windows Release use `%USERPROFILE%\.agentbridge\bin\agentbridge.cmd`; en Linux/macOS use `~/.agentbridge/bin/agentbridge`.

## Actualización

Instalación Release:

```bash
agentbridge update
agentbridge update --install
agentbridge setup /ruta/absoluta/del/proyecto
agentbridge doctor /ruta/absoluta/del/proyecto
```

Instalación npm:

```bash
npm install --global @headstone/agentbridge@latest
agentbridge setup /ruta/absoluta/del/proyecto
agentbridge doctor /ruta/absoluta/del/proyecto
```

Reinicie los dos clientes después de actualizar. Las instalaciones Release guardan versiones anteriores y permiten `agentbridge rollback`.

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
- Claude y Codex no ven las mismas conversaciones: compare sus valores absolutos de `AGENTBRIDGE_DB_PATH` y repita `setup`.
- El agente remoto es incorrecto: Claude requiere `AGENTBRIDGE_AGENT=claude` y Codex requiere `AGENTBRIDGE_AGENT=codex`.
- `database is locked`: mantenga SQLite en un disco local, detenga escritores activos y copie todo `.agentbridge` al hacer la copia de seguridad.
- `PEER_BUSY`: compruebe autenticación y salud del proveedor, espere a que termine el trabajo activo y use `retry_discussion`.
- PowerShell bloquea el script: primero valide SHA-256; después use `Unblock-File` y el comando Bypass documentado.
- `Permission denied` en Unix: aplique `chmod +x install.sh` al paquete ya verificado.
- Un segundo proyecto no muestra herramientas: ejecute `setup` específicamente para ese proyecto.
- AgentBridge está dentro de una VM y Codex App solo en el anfitrión: instale Codex dentro de la VM o utilice una CLI autenticada dentro de la VM.

La matriz completa de diagnóstico para automatización está en [README.ai.md](README.ai.md). El manual chino completo se conserva en [README.md](README.md).

## Seguridad

AgentBridge no omite los permisos de Claude. Codex usa de forma predeterminada un sandbox de solo lectura. Las conversaciones se guardan sin cifrar en `.agentbridge/agentbridge.sqlite`; proteja el directorio según la sensibilidad del proyecto. No publique copias de configuración del proveedor, porque pueden contener variables o credenciales de otros MCP.

## Licencia

AgentBridge v0.5.0 y posteriores se distribuye como código fuente disponible bajo [PolyForm Noncommercial License 1.0.0](LICENSE). La licencia pública permite usos no comerciales, pero no concede uso comercial a terceros. Para cualquier uso comercial se necesita una licencia escrita independiente de HeadStone1; consulte [la guía comercial](COMMERCIAL_LICENSE.md).

Las versiones publicadas hasta v0.4.2 conservan Apache-2.0. Consulte el [historial de licencias](LICENSE_HISTORY.md). Los componentes de terceros mantienen sus propias licencias.
