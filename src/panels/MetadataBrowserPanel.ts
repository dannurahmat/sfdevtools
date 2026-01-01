import * as vscode from 'vscode';
import { SfCli } from '../sfCli';
import { ManifestHelper } from '../manifestHelper';
import * as path from 'path';
import * as fs from 'fs';
import { OutputChannel } from '../utils/outputChannel';

export class MetadataBrowserPanel {
    public static currentPanel: MetadataBrowserPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _sfCli: SfCli;
    private _manifestHelper: ManifestHelper;

    private _componentCache: Map<string, { fullName: string, id: string }[]> = new Map();
    private _activeManifestPaths: Map<string, string> = new Map();
    private _lastManifestDir: string | undefined;
    private _lastRetrieveDir: string | undefined;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._sfCli = new SfCli();
        this._manifestHelper = new ManifestHelper();

        this._update();
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'getMetadataTypes':
                        try {
                             const types = await this._sfCli.describeMetadata();
                             this._panel.webview.postMessage({ command: 'setMetadataTypes', types });
                        } catch (e) {
                             vscode.window.showErrorMessage(`Failed to load metadata types: ${e}`);
                             this._panel.webview.postMessage({ command: 'setMetadataTypes', types: [] });
                        }
                        return;
                    case 'getComponents':
                        {
                            const type = message.type;
                            let components: { fullName: string, id: string }[] = [];
                            if (this._componentCache.has(type)) {
                                components = this._componentCache.get(type)!;
                            } else {
                                try {
                                    components = await this._sfCli.listMetadata(type);
                                    this._componentCache.set(type, components);
                                } catch (e) {
                                    vscode.window.showErrorMessage(`Error fetching components: ${e}`);
                                }
                            }
                            // Read package.xml to pre-select items
                            const activePath = this._activeManifestPaths.get('package.xml');
                            const packageItems = this._manifestHelper.readManifest('package.xml', activePath);
                            this._panel.webview.postMessage({ 
                                command: 'setComponents', 
                                type, 
                                components,
                                packageItems: packageItems.filter(item => item.type === type).map(item => item.fullName)
                            });
                        }
                        return;

                    case 'runAction':
                        const { action, items } = message;
                        if (!items || items.length === 0) return;

                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Running ${action}...`,
                            cancellable: false
                        }, async () => {

                             try {
                                 const apiVersion = await this._sfCli.getOrgApiVersion();
                                 if (action === 'retrieve' || action === 'retrieve-custom') {
                                     // Determine default package directory from sfdx-project.json
                                     let defaultPath = 'force-app/main/default';
                                     try {
                                         const projectJsonPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'sfdx-project.json');
                                         if (fs.existsSync(projectJsonPath)) {
                                             const projectConfig = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
                                             const defaultPkg = projectConfig.packageDirectories?.find((p: any) => p.default);
                                             if (defaultPkg) defaultPath = defaultPkg.path;
                                         }
                                     } catch (e) { /* ignore */ }

                                     let outputDir: string | undefined;
                                     if (action === 'retrieve-custom') {
                                         outputDir = this._lastRetrieveDir;
                                         if (!outputDir) {
                                             const uri = await vscode.window.showOpenDialog({
                                                 canSelectFiles: false,
                                                 canSelectFolders: true,
                                                 canSelectMany: false,
                                                 openLabel: 'Select Destination'
                                             });
                                             if (uri && uri[0]) {
                                                 outputDir = uri[0].fsPath;
                                                 this._lastRetrieveDir = outputDir;
                                             } else {
                                                 return; // Cancelled
                                             }
                                         }
                                     } else {
                                         // 'retrieve' action always uses project default
                                         outputDir = undefined;
                                     }

                                     const manifestPath = await this._getOrSelectManifestPath('package.xml', action === 'retrieve');
                                     if (!manifestPath) return;

                                     await this._manifestHelper.updateManifest('package.xml', items, apiVersion, manifestPath);
                                     
                                     const response = await this._sfCli.retrieveByManifest(manifestPath, outputDir);
                                     
                                     if (response.status === 0) {
                                         const files = response.result.files;
                                         const count = files.length;
                                         files.forEach((f: any) => OutputChannel.appendLine(`- ${f.filePath}`));
                                         OutputChannel.show();

                                         if (count === 0) {
                                             vscode.window.showWarningMessage(`Command executed but 0 files were returned. See Output channel.`);
                                         } else {
                                             const target = outputDir ? outputDir : defaultPath;
                                             vscode.window.showInformationMessage(`Successfully retrieved ${count} files to ${target}.`);
                                         }
                                     } else {
                                         OutputChannel.show();
                                         vscode.window.showErrorMessage(`Retrieve failed with status ${response.status}. See Output.`);
                                     }
                                 } else {
                                     const targetPath = await this._getOrSelectManifestPath(action);
                                     if (!targetPath) return;

                                     const savedPath = await this._manifestHelper.updateManifest(action, items, apiVersion, targetPath);
                                     this._activeManifestPaths.set(action, savedPath);

                                     const doc = await vscode.workspace.openTextDocument(savedPath);
                                     await vscode.window.showTextDocument(doc);

                                     vscode.window.showInformationMessage(`Successfully updated ${action} at: ${savedPath}`);

                                     if (this._panel.webview && action === 'package.xml') {
                                         this._panel.webview.postMessage({ 
                                             command: 'setComponents', 
                                             type: items[0].type, 
                                             components: this._componentCache.get(items[0].type) || [],
                                             packageItems: items.map((i: any) => i.fullName) 
                                         });
                                     }
                                 }
                             } catch (error: any) {
                                 vscode.window.showErrorMessage(`Action failed: ${error.message}`);
                             }
                        });
                        return;

                    case 'deleteManifestFolder':
                        {
                            const confirm = await vscode.window.showWarningMessage(
                                `Are you sure you want to delete the manifest folder and all selected manifest files? This cannot be undone.`,
                                { modal: true },
                                'Yes, Delete All'
                            );

                            if (confirm === 'Yes, Delete All') {
                                try {
                                    const pathsToDelete = new Set<string>();
                                    
                                    // Collect parent directories of all active manifest paths
                                    this._activeManifestPaths.forEach(p => {
                                        pathsToDelete.add(path.dirname(p));
                                    });

                                    // Add default manifest directory
                                    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                                        const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
                                        const defaultManifestDir = path.join(root, 'manifest');
                                        pathsToDelete.add(defaultManifestDir);
                                    }

                                    await this._manifestHelper.deleteManifests(Array.from(pathsToDelete));
                                    this._activeManifestPaths.clear();
                                    this._lastManifestDir = undefined;
                                    
                                    vscode.window.showInformationMessage(`Successfully reset all manifests and folders.`);
                                    this._panel.webview.postMessage({ command: 'clearSelections' });
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(`Failed to delete manifest folders: ${e.message}`);
                                }
                            }
                        }
                        return;
                    
                    case 'showWarning':
                        vscode.window.showWarningMessage(message.text);
                        return;
                    case 'showError':
                        vscode.window.showErrorMessage(message.text);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (MetadataBrowserPanel.currentPanel) {
            MetadataBrowserPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'sfDevToolsMetadataBrowser',
            'SF Metadata Browser',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: []
            }
        );

        MetadataBrowserPanel.currentPanel = new MetadataBrowserPanel(panel, extensionUri);
    }

    public dispose() {
        MetadataBrowserPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private _update() {
        this._panel.title = "SF Metadata Browser";
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <title>SF Metadata Browser</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 0; display: flex; height: 100vh; overflow: hidden; color: var(--vscode-foreground); background-color: var(--vscode-editor-background); }
        .sidebar { width: 250px; border-right: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; background-color: var(--vscode-sideBar-background); }
        .sidebar-header { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .sidebar-header input { width: 100%; box-sizing: border-box; padding: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
        .types-list { overflow-y: auto; flex-grow: 1; }
        .type-item { padding: 6px 10px; cursor: pointer; }
        .type-item:hover { background-color: var(--vscode-list-hoverBackground); }
        .type-item.selected { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        
        .main-content { flex-grow: 1; display: flex; flex-direction: column; padding: 10px; overflow: hidden; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; min-height: 30px; }
        .header h2 { margin: 0; font-size: 16px; font-weight: 600; }
        .controls { display: flex; gap: 10px; align-items: center; width: 60%; }
        .controls input { flex-grow: 1; padding: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
        
        .component-list-container { flex-grow: 1; border: 1px solid var(--vscode-panel-border); overflow: hidden; position: relative; margin-bottom: 10px; }
        .component-list { height: 100%; overflow-y: auto; padding: 5px; }
        .component-item { padding: 4px 10px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--vscode-panel-border); }
        .component-item:hover { background-color: var(--vscode-list-hoverBackground); }
        .component-item label { cursor: pointer; display: flex; align-items: center; flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 10px; }
        .component-item input[type="checkbox"] { flex-shrink: 0; margin-right: 8px; }
        
        .footer { display: flex; gap: 10px; margin-top: auto; }
        button { background-color: #0078d4; color: #ffffff; border: none; padding: 8px 12px; cursor: pointer; font-size: 13px; border-radius: 2px; flex-grow: 1; }
        button:hover { background-color: #106ebe; }
        button:disabled { opacity: 0.6; cursor: not-allowed; }

        .split-button-container { display: flex; flex-grow: 1; position: relative; }
        .split-button-main { flex-grow: 1; border-top-right-radius: 0; border-bottom-right-radius: 0; }
        .split-button-arrow { width: 30px; flex-grow: 0; border-left: 1px solid rgba(255,255,255,0.2); border-top-left-radius: 0; border-bottom-left-radius: 0; display: flex; justify-content: center; align-items: center; }
        .dropdown-menu { position: absolute; bottom: 100%; left: 0; right: 0; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); border-radius: 2px; display: none; flex-direction: column; z-index: 1000; margin-bottom: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.3); }
        .dropdown-item { padding: 8px 12px; cursor: pointer; color: var(--vscode-menu-foreground); font-size: 13px; text-align: left; }
        .dropdown-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
        .dropdown-menu.show { display: flex; }

        .loading-overlay { position: absolute; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,0.2); display: flex; justify-content: center; align-items: center; z-index: 100; }
        .spinner { border: 2px solid rgba(0, 120, 212, 0.2); border-top: 2px solid #0078d4; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        
        #no-selection { display: flex; justify-content: center; align-items: center; height: 100%; color: var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="sidebar-header">
            <input type="text" id="type-search" placeholder="Search Metadata Types...">
        </div>
        <div id="types-list" class="types-list">
             <div class="loading-overlay" style="position:relative; height: 50px; background:none; display:flex;">
                <div class="spinner"></div>
             </div>
        </div>
    </div>
    <div class="main-content">
        <div class="header">
            <h2 id="current-type-title">Select a Type</h2>
            <div class="controls" id="controls" style="display:none;">
                <input type="text" id="component-search" placeholder="Search components...">
                <label style="display:flex; align-items:center; gap:5px; flex-shrink:0;"><input type="checkbox" id="select-all"> Select All</label>
                <button style="margin-left: 10px; padding: 6px 16px; font-weight: 600; flex-grow: 0; min-width: 80px;" onclick="resetAll()">Reset</button>
            </div>
        </div>

        <div class="component-list-container">
            <div id="component-list" class="component-list">
                <div id="no-selection">Select a Metadata Type from the sidebar</div>
            </div>
            <div id="loading" class="loading-overlay" style="display:none;">
                <div class="spinner"></div>
            </div>
        </div>

        <div class="footer" id="footer-actions" style="display:none;">
            <div class="split-button-container">
                <button class="split-button-main" onclick="runAction('retrieve')" title="Retrieve to default project folder">Retrieve Source</button>
                <button class="split-button-arrow" onclick="toggleDropdown(event)" title="More retrieve options">▼</button>
                <div id="retrieve-dropdown" class="dropdown-menu">
                    <div class="dropdown-item" onclick="runAction('retrieve-custom')">Retrieve to Custom Folder...</div>
                </div>
            </div>
            <button onclick="runAction('package.xml')">Add to package.xml</button>
            <button onclick="runAction('destructiveChangesPre.xml')">Add to Pre-Destructive</button>
            <button onclick="runAction('destructiveChangesPost.xml')">Add to Post-Destructive</button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        let allTypes = [];
        let currentComponents = [];
        let currentType = '';
        let selectedComponents = new Set();

        window.addEventListener('message', event => {
            const message = event.data;
            switch(message.command) {
                case 'setMetadataTypes':
                    allTypes = message.types;
                    renderTypes(allTypes);
                    break;
                case 'setComponents':
                    if (message.type === currentType) {
                        currentComponents = message.components;
                        if (message.packageItems) {
                            message.packageItems.forEach(fullName => {
                                selectedComponents.add(currentType + ':' + fullName);
                            });
                        }
                        renderComponents(currentComponents);
                        document.getElementById('loading').style.display = 'none';
                    }
                    break;
                case 'clearSelections':
                    selectedComponents.clear();
                    document.getElementById('select-all').checked = false;
                    renderComponents(currentComponents.filter(c => {
                        const name = typeof c === 'object' ? c.fullName : c;
                        return name.toLowerCase().includes(document.getElementById('component-search').value.toLowerCase());
                    }));
                    break;
            }
        });

        vscode.postMessage({ command: 'getMetadataTypes' });

        document.getElementById('type-search').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const filtered = allTypes.filter(t => t.toLowerCase().includes(term));
            renderTypes(filtered);
        });

        function renderTypes(types) {
            const list = document.getElementById('types-list');
            list.innerHTML = '';
            types.forEach(t => {
                const div = document.createElement('div');
                div.className = 'type-item' + (t === currentType ? ' selected' : '');
                div.textContent = t;
                div.onclick = () => selectType(t);
                list.appendChild(div);
            });
        }

        function selectType(type) {
            currentType = type;
            renderTypes(allTypes.filter(t => t.toLowerCase().includes(document.getElementById('type-search').value.toLowerCase())));
            document.getElementById('current-type-title').textContent = type;
            document.getElementById('controls').style.display = 'flex';
            document.getElementById('component-list').innerHTML = '';
            document.getElementById('loading').style.display = 'flex';
            document.getElementById('footer-actions').style.display = 'flex';
            document.getElementById('component-search').value = '';
            document.getElementById('select-all').checked = false;
            vscode.postMessage({ command: 'getComponents', type });
        }

        document.getElementById('component-search').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const filtered = currentComponents.filter(c => {
                const name = typeof c === 'object' ? c.fullName : c;
                return name.toLowerCase().includes(term);
            });
            renderComponents(filtered);
        });

        function renderComponents(components) {
            const list = document.getElementById('component-list');
            list.innerHTML = '';
            if(components.length === 0) {
                list.innerHTML = '<div style="padding:10px; color:#888;">No components found.</div>';
                return;
            }
            components.forEach(c => {
                const name = typeof c === 'object' ? c.fullName : c;
                const key = currentType + ':' + name;
                const div = document.createElement('div');
                div.className = 'component-item';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.id = 'cb_' + name;
                cb.checked = selectedComponents.has(key);
                cb.onchange = (e) => toggleSelection(key, e.target.checked);
                const label = document.createElement('label');
                label.htmlFor = 'cb_' + name;
                label.textContent = name;
                div.appendChild(cb);
                div.appendChild(label);
                list.appendChild(div);
            });
            updateSelectAllState(components);
        }

        function toggleSelection(key, checked) {
            if (checked) selectedComponents.add(key);
            else selectedComponents.delete(key);
        }
        
        document.getElementById('select-all').addEventListener('change', (e) => {
            const checked = e.target.checked;
            const term = document.getElementById('component-search').value.toLowerCase();
            const visible = currentComponents.filter(c => {
                const name = typeof c === 'object' ? c.fullName : c;
                return name.toLowerCase().includes(term);
            });
            visible.forEach(c => {
                const name = typeof c === 'object' ? c.fullName : c;
                const key = currentType + ':' + name;
                if(checked) selectedComponents.add(key);
                else selectedComponents.delete(key);
            });
            renderComponents(visible);
        });

        function updateSelectAllState(visibleComponents) {
            if (visibleComponents.length === 0) {
                document.getElementById('select-all').checked = false;
                return;
            }
            const allSelected = visibleComponents.every(c => {
                const name = typeof c === 'object' ? c.fullName : c;
                return selectedComponents.has(currentType + ':' + name);
            });
            document.getElementById('select-all').checked = allSelected;
        }

        function toggleDropdown(event) {
            event.stopPropagation();
            document.getElementById('retrieve-dropdown').classList.toggle('show');
        }

        window.addEventListener('click', () => {
            const r = document.getElementById('retrieve-dropdown');
            if (r) r.classList.remove('show');
        });

        function resetAll() {
            vscode.postMessage({ command: 'deleteManifestFolder' });
        }

        function clearManifest(action) {
            // No direct clear anymore
        }

        function runAction(action) {
            const items = [];
            selectedComponents.forEach(key => {
                const parts = key.split(':');
                items.push({ type: parts[0], fullName: parts.slice(1).join(':') });
            });
            if (items.length === 0) {
                vscode.postMessage({ command: 'showWarning', text: 'No components selected.' });
                return;
            }
            vscode.postMessage({ command: 'runAction', action, items });
        }
    </script>
</body>
</html>`;
    }

    private async _getOrSelectManifestPath(action: string, forceDefault: boolean = false): Promise<string | undefined> {
        let targetPath = this._activeManifestPaths.get(action);
        if (targetPath) return targetPath;

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const defaultLoc = path.join(root, 'manifest', action);
            if (fs.existsSync(defaultLoc)) {
                this._activeManifestPaths.set(action, defaultLoc);
                return defaultLoc;
            }
        }

        if (this._lastManifestDir) {
            targetPath = path.join(this._lastManifestDir, action);
            this._activeManifestPaths.set(action, targetPath);
            return targetPath;
        }

        if (forceDefault && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
            targetPath = path.join(root, 'manifest', action);
            this._activeManifestPaths.set(action, targetPath);
            this._lastManifestDir = path.dirname(targetPath);
            return targetPath;
        }

        const defaultRelLoc = `manifest/${action}`;
        const choice = await vscode.window.showQuickPick(
            [`Save to Default (${defaultRelLoc})`, 'Save to Custom Location...'],
            { placeHolder: `Select destination for ${action}` }
        );
        if (!choice) return undefined;

        if (choice === `Save to Default (${defaultRelLoc})`) {
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
                targetPath = path.join(root, 'manifest', action);
                this._lastManifestDir = path.join(root, 'manifest');
            } else {
                return undefined;
            }
        } else {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, action)),
                filters: { 'XML files': ['xml'] },
                title: `Save ${action} to...`
            });
            if (uri) {
                targetPath = uri.fsPath;
                this._lastManifestDir = path.dirname(targetPath);
            } else {
                return undefined;
            }
        }

        if (targetPath) {
            this._activeManifestPaths.set(action, targetPath);
        }
        return targetPath;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
