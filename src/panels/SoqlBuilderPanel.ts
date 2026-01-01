import * as vscode from 'vscode';
import { SfCli } from '../sfCli';
import * as path from 'path';
import * as fs from 'fs';

export class SoqlBuilderPanel {
    public static currentPanel: SoqlBuilderPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _sfCli: SfCli;
    private _mode: 'data' | 'tooling';

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, mode: 'data' | 'tooling') {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._sfCli = new SfCli();
        this._mode = mode;

        this._update();
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'getObjects':
                        try {
                            let objects: string[] = [];
                            if (this._mode === 'tooling') {
                                // For Tooling API, use the metadata types list as a proxy for queryable objects
                                objects = await this._sfCli.describeMetadata();
                            } else {
                                objects = await this._sfCli.listSObjects('all');
                            }
                            this._panel.webview.postMessage({ command: 'setObjects', objects });
                        } catch (e) {
                            vscode.window.showErrorMessage(`Error fetching objects: ${e}`);
                        }
                        return;

                    case 'describeObject':
                        try {
                            const { sobject, parentPath } = message;
                            const useTooling = this._mode === 'tooling';
                            const { fields, childRelationships } = await this._sfCli.describeSObject(sobject, useTooling);
                            this._panel.webview.postMessage({ command: 'setFields', fields, childRelationships, parentPath });
                        } catch (e) {
                            vscode.window.showErrorMessage(`Error describing ${message.sobject}: ${e}`);
                            this._panel.webview.postMessage({ command: 'stopFieldsLoading' });
                        }
                        return;

                    case 'runQuery':
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Executing Query...`,
                            cancellable: false
                        }, async () => {
                            try {
                                const useTooling = this._mode === 'tooling';
                                const result = await this._sfCli.executeQuery(message.query, useTooling);
                                this._panel.webview.postMessage({ command: 'setResults', result });
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Query failed: ${e.message}`);
                                this._panel.webview.postMessage({ command: 'stopQueryLoading' });
                            }
                        });
                        return;
                    case 'saveFile':
                        try {
                            const { content, fileName } = message;
                            const uri = await vscode.window.showSaveDialog({
                                defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0].uri.fsPath || '', fileName)),
                                filters: { 'Data': [fileName.split('.').pop()] }
                            });
                            if (uri) {
                                fs.writeFileSync(uri.fsPath, content);
                                vscode.window.showInformationMessage(`Successfully saved: ${uri.fsPath}`);
                            }
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Failed to save file: ${e.message}`);
                        }
                        return;
                    case 'showWarning':
                        vscode.window.showWarningMessage(message.text);
                        return;
                    case 'showError':
                        vscode.window.showErrorMessage(message.text);
                        return;
                    case 'openSubqueryResult':
                        try {
                            const { data } = message;
                            const content = JSON.stringify(data, null, 2);
                            const doc = await vscode.workspace.openTextDocument({
                                content,
                                language: 'json'
                            });
                            await vscode.window.showTextDocument(doc, {
                                preview: false,
                                viewColumn: vscode.ViewColumn.Beside
                            });
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Error opening subquery results: ${e.message}`);
                        }
                        return;
                        return;
                        case 'openBrowser':
                        const { recordId } = message;
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Opening record ${recordId} in browser...`,
                            cancellable: false
                        }, async () => {
                            try {
                                await this._sfCli.openRecordPage(recordId);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Error opening browser: ${e.message}`);
                            }
                        });
                        return;
                    case 'viewDetails':
                         vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Fetching details for ${message.data.Id}...`,
                            cancellable: false
                        }, async () => {
                            try {
                                const fullRecord = await this._sfCli.getSingleRecord(message.sobject, message.data.Id);
                                const content = JSON.stringify(fullRecord, null, 2);
                                const doc = await vscode.workspace.openTextDocument({
                                    content,
                                    language: 'json'
                                });
                                await vscode.window.showTextDocument(doc, {
                                    preview: false,
                                    viewColumn: vscode.ViewColumn.Beside
                                });
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Error fetch details: ${e.message}`);
                            }
                        });
                        return;
                }
            },
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri, mode: 'data' | 'tooling' = 'data') {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SoqlBuilderPanel.currentPanel) {
            if (SoqlBuilderPanel.currentPanel._mode !== mode) {
                SoqlBuilderPanel.currentPanel.dispose();
            } else {
                SoqlBuilderPanel.currentPanel._panel.reveal(column);
                return;
            }
        }

        const title = mode === 'tooling' ? 'Tooling Query' : 'SOQL Builder';
        const panel = vscode.window.createWebviewPanel(
            'sfDevToolsSoqlBuilder',
            title,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [] // This is usually typed as vscode.Uri[], so pass empty array or undefined correctly if needed. Actually it expects Uri[].
            }
        );

        SoqlBuilderPanel.currentPanel = new SoqlBuilderPanel(panel, extensionUri, mode);
    }

    public dispose() {
        SoqlBuilderPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        this._panel.title = this._mode === 'tooling' ? "Tooling Query" : "SOQL Builder";
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
    <title>${this._mode === 'tooling' ? 'Tooling Query' : 'SOQL Builder'}</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 0; display: flex; height: 100vh; overflow: hidden; color: var(--vscode-foreground); background-color: var(--vscode-editor-background); }
        .sidebar { width: 250px; border-right: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; background-color: var(--vscode-sideBar-background); }
        .sidebar-header { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .sidebar-header input { width: 100%; box-sizing: border-box; padding: 6px 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
        
        .list-item { padding: 6px 10px; cursor: pointer; }
        .list-item:hover { background-color: var(--vscode-list-hoverBackground); }
        .list-item.selected { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        
        .main { flex-grow: 1; display: flex; flex-direction: column; overflow: hidden; }
        .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); background-color: var(--vscode-sideBar-background); }
        .tab { padding: 8px 16px; cursor: pointer; border-right: 1px solid var(--vscode-panel-border); opacity: 0.7; }
        .tab:hover { background-color: var(--vscode-list-hoverBackground); opacity: 1; }
        .tab.active { background-color: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-editor-background); font-weight: bold; opacity: 1; margin-bottom: -1px; }
        
        .tab-content { padding: 0; flex-grow: 1; display: none; overflow: hidden; flex-direction: column; position: relative; }
        .tab-content.active { display: flex; }
        
        .builder-container { display: flex; height: 100%; }
        .selectors-lat { width: 380px; display: flex; flex-direction: column; border-right: 1px solid var(--vscode-panel-border); background-color: var(--vscode-sideBar-background); }
        .selector-section { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; border-bottom: 1px solid var(--vscode-panel-border); }
        .selector-section:last-child { border-bottom: none; }
        
        
        .fields-header { padding: 10px 15px; font-weight: bold; border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 8px; }
        .fields-title-row { display: flex; justify-content: space-between; align-items: center; font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
        .fields-header input { width: 100%; box-sizing: border-box; padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; font-size: 13px; }

        .fields-list { overflow-y: auto; flex-grow: 1; padding: 5px 8px; }
        .field-item { display: flex; align-items: center; padding: 4px 0; gap: 6px; }
        .field-item label { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-grow: 1; font-size: 13px; }
        
        .rel-container { margin-left: 15px; border-left: 1px solid var(--vscode-panel-border); padding-left: 5px; }
        .expander { cursor: pointer; font-size: 10px; width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--vscode-panel-border); border-radius: 2px; }
        .expander:hover { background: var(--vscode-list-hoverBackground); }
        .expander.disabled { opacity: 0.3; cursor: not-allowed; pointer-events: none; }
        
        .query-lat { flex-grow: 1; display: flex; flex-direction: column; position: relative; }
        .query-box-header { padding: 10px 12px; font-size: 11px; text-transform: uppercase; font-weight: bold; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
        .query-box { flex-grow: 1; width: 100%; border: none; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 14px); padding: 15px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); resize: none; border-bottom: 1px solid var(--vscode-panel-border); }
        .query-footer { padding: 10px 12px; display: flex; justify-content: flex-end; }

        .results-container { flex-grow: 1; overflow: auto; padding: 0 20px 20px 20px; box-sizing: border-box; }
        table { margin-top: 20px; width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; border: 1px solid var(--vscode-panel-border); border-bottom: none; margin-right: 20px; }
        th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); white-space: nowrap; vertical-align: middle; }
        .id-link { color: #0078d4; text-decoration: none; cursor: pointer; font-weight: 500; }
        .id-link:hover { text-decoration: underline; }
        td:last-child, th:last-child { border-right: none; }
        th { background-color: var(--vscode-sideBar-background); font-weight: 600; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 0 var(--vscode-panel-border); border-top: 1px solid var(--vscode-panel-border); }
        
        .pagination-footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border); gap: 10px; flex-wrap: wrap; }
        
        .export-dropdown button { background-color: #0078d4; color: #ffffff; border: none; padding: 6px 14px; cursor: pointer; border-radius: 2px; font-weight: 600; font-size: 13px; }
        .export-dropdown button:hover { background-color: #106ebe; }
        button { background-color: #0078d4; color: #ffffff; border: none; padding: 6px 14px; cursor: pointer; border-radius: 2px; font-weight: 600; font-size: 13px; }
        button:hover { background-color: #106ebe; }
        button.secondary { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        button.secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        
        .btn-small { padding: 4px 8px; font-size: 12px; }
        .btn-blue { background-color: #0078d4; color: #ffffff; font-weight: bold; padding: 4px 8px; border-radius: 2px; border: none; cursor: pointer; font-size: 11px; margin-right: 6px; }
        .btn-blue:hover { background-color: #106ebe; }
        
        .subquery-cell { padding: 12px 14px; }
        .subquery-count { font-weight: bold; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; display: block; }
        .subquery-btn-row { display: flex; align-items: center; margin-top: 4px; }

        select, input[type="number"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; border-radius: 2px; }

        .export-dropdown { position: relative; display: inline-block; }
        .dropdown-content { display: none; position: absolute; right: 0; background-color: var(--vscode-menu-background); min-width: 140px; box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.2); z-index: 1001; border: 1px solid var(--vscode-menu-border); border-radius: 2px; }
        .dropdown-content a { color: var(--vscode-menu-foreground); padding: 8px 12px; text-decoration: none; display: block; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
        .dropdown-content a:hover { background-color: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
        .export-dropdown:hover .dropdown-content { display: block; }

        .spinner { border: 2px solid rgba(0, 120, 212, 0.2); border-top: 2px solid #0078d4; border-radius: 50%; width: 22px; height: 22px; animation: spin 1s linear infinite; }
        .spinner-container { display: flex; justify-content: center; align-items: center; padding: 20px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        
        .loading-overlay { position: absolute; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,0.05); display: flex; justify-content: center; align-items: center; z-index: 100; border-radius: inherit; }
        
        /* Custom Context Menu */
        .custom-context-menu {
            position: fixed; display: none; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); box-shadow: 0 2px 8px rgba(0,0,0,0.2); z-index: 2000;
        }
        .custom-context-menu .menu-item {
            padding: 6px 16px; cursor: pointer; color: var(--vscode-menu-foreground); font-size: 12px;
        }
        .custom-context-menu .menu-item:hover {
            background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground);
        }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="sidebar-header">
            <h3 style="margin:0 0 10px 0; font-size: 12px; text-transform: uppercase;">Objects</h3>
            <input type="text" id="object-search" placeholder="Search objects...">
        </div>
        <div id="object-list" style="overflow-y:auto; flex-grow:1;">
            <div class="spinner-container"><div class="spinner"></div></div>
        </div>
    </div>
    
    <div class="main">
        <div class="tabs">
            <div class="tab active" onclick="switchTab('builder')">Query Builder</div>
            <div class="tab" id="results-tab-header" onclick="switchTab('results')">Results</div>
        </div>
        
        <div id="tab-builder" class="tab-content active">
            <div class="builder-container">
                <div class="selectors-lat" id="selectors-container">
                    <div class="selector-section">
                        <div class="fields-header">
                            <div class="fields-title-row">
                                <span id="fields-title">Fields</span>
                            </div>
                            <input type="text" id="field-search" placeholder="Filter fields...">
                        </div>
                        <div id="fields-list" class="fields-list">
                            <div style="padding:10px; color:#888; text-align:center;">Select an object</div>
                        </div>
                        <div id="fields-loading" class="loading-overlay" style="display:none;">
                            <div class="spinner"></div>
                        </div>
                    </div>

                    <div class="selector-section" id="child-rel-section" style="${this._mode === 'tooling' ? 'display:none;' : ''}">
                        <div class="fields-header">
                            <div class="fields-title-row">
                                <span>Child Relationships</span>
                            </div>
                            <input type="text" id="rel-search" placeholder="Filter relationships...">
                        </div>
                        <div id="rel-list" class="fields-list">
                            <div style="padding:10px; color:#888; text-align:center;">Select an object</div>
                        </div>
                        <div id="rel-loading" class="loading-overlay" style="display:none;">
                            <div class="spinner"></div>
                        </div>
                    </div>
                </div>
                
                <div class="query-lat">
                    <div class="query-box-header">SOQL Query</div>
                    <textarea id="soql-query" class="query-box" placeholder="SELECT Id FROM ${this._mode === 'tooling' ? 'Flow...' : 'Account...'} "></textarea>
                    <div class="query-footer">
                        <button onclick="runQuery()" style="margin-right: 10px;">Run Query</button>
                        <button class="secondary" onclick="copyQuery()">Copy Query</button>
                    </div>
                    <div id="query-loading" class="loading-overlay" style="display:none;">
                        <div class="spinner"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <div id="tab-results" class="tab-content">
            <div style="display:flex; justify-content:space-between; align-items:center; padding: 15px 20px; border-bottom: 1px solid var(--vscode-panel-border);">
                <h3 style="margin:0; font-size: 14px;">Query Results</h3>
                <div class="export-dropdown">
                    <button class="btn-small">Export ▼</button>
                    <div class="dropdown-content">
                        <a href="#" onclick="exportData('csv', 'copy')">Copy to CSV</a>
                        <a href="#" onclick="exportData('xlsx', 'copy')">Copy to Excel (TSV)</a>
                        <hr style="margin:0; opacity:0.1;">
                        <a href="#" onclick="exportData('csv', 'download')">Download CSV</a>
                        <a href="#" onclick="exportData('xlsx', 'download')">Download Excel (.xlsx)</a>
                    </div>
                </div>
            </div>
            
            <div id="results-table-container" class="results-container">
                <div id="results-list" class="results-list">
                    <div style="padding:20px; text-align:center; color:#888;">No results yet. Run a query first.</div>
                </div>
            </div>
            
            <div class="pagination-footer" id="pagination" style="display:none;">
                <div id="pagination-info" style="font-size:12px; color: var(--vscode-descriptionForeground);"></div>
                <div style="display:flex; align-items:center; gap:12px;">
                    <select id="page-size-select" onchange="updatePageSize()" style="font-size:11px;">
                        <option value="10">10</option>
                        <option value="25">25</option>
                        <option value="50" selected>50</option>
                        <option value="100">100</option>
                        <option value="500">500</option>
                    </select>
                    <div style="display:flex; gap:6px;">
                        <button class="btn-small" id="prev-btn" onclick="prevPage()">Prev</button>
                        <button class="btn-small" id="next-btn" onclick="nextPage()">Next</button>
                    </div>
                    <input type="number" id="jump-page-input" style="width: 45px; font-size:11px;" min="1" placeholder="Page" onkeydown="if(event.key==='Enter') jumpToPage()">
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        let allObjects = [];
        let currentObject = '';
        let baseFields = [];
        let baseChildRels = [];
        let relData = {}; // Path -> { fields, childRelationships }
        let selectedFields = new Set();
        
        let allResults = [];
        let currentPage = 1;
        let pageSize = 50;
        const isTooling = ${this._mode === 'tooling'};
        
        vscode.postMessage({ command: 'getObjects' });
        
        window.addEventListener('message', event => {
            const message = event.data;
            switch(message.command) {
                case 'setObjects':
                    allObjects = message.objects;
                    renderObjects(allObjects);
                    break;
                case 'setFields':
                    const { fields, childRelationships, parentPath } = message;
                    if (!parentPath) {
                        baseFields = fields;
                        baseChildRels = childRelationships || [];
                        relData = {};
                        selectedFields.clear();
                        if(baseFields.find(f => f.name === 'Id')) selectedFields.add('Id');
                        if(baseFields.find(f => f.name === 'Name')) selectedFields.add('Name');
                    } else {
                        relData[parentPath] = { fields, childRelationships: childRelationships || [] };
                    }
                    renderFields();
                    updateQuery();
                    document.getElementById('fields-loading').style.display = 'none';
                    document.getElementById('rel-loading').style.display = 'none';
                    break;
                case 'setResults':
                    allResults = message.result.records;
                    currentPage = 1;
                    renderResults();
                    document.getElementById('query-loading').style.display = 'none';
                    switchTab('results');
                    break;
                case 'stopFieldsLoading':
                    document.getElementById('fields-loading').style.display = 'none';
                    document.getElementById('rel-loading').style.display = 'none';
                    break;
            }
        });
        
        function renderObjects(objects) {
            const list = document.getElementById('object-list');
            list.innerHTML = '';
            objects.forEach(obj => {
                const div = document.createElement('div');
                div.className = 'list-item' + (obj === currentObject ? ' selected' : '');
                div.textContent = obj;
                div.onclick = () => selectObject(obj);
                list.appendChild(div);
            });
        }
        
        function selectObject(obj) {
            currentObject = obj;
            document.getElementById('fields-title').textContent = obj;
            renderObjects(allObjects.filter(o => o.toLowerCase().includes(document.getElementById('object-search').value.toLowerCase())));
            document.getElementById('fields-loading').style.display = 'flex';
            document.getElementById('rel-loading').style.display = 'flex';
            switchTab('builder');
            vscode.postMessage({ command: 'describeObject', sobject: obj });
        }
        
        document.getElementById('object-search').addEventListener('input', (e) => {
            renderObjects(allObjects.filter(o => o.toLowerCase().includes(e.target.value.toLowerCase())));
        });

        document.getElementById('field-search').addEventListener('input', () => renderFields());
        document.getElementById('rel-search').addEventListener('input', () => renderFields());
        
        function renderFields() {
            const fieldList = document.getElementById('fields-list');
            const relList = document.getElementById('rel-list');
            fieldList.innerHTML = '';
            relList.innerHTML = '';
            
            const fieldSearch = document.getElementById('field-search').value.toLowerCase();
            const relSearch = document.getElementById('rel-search').value.toLowerCase();
            
            renderFieldList(baseFields, '', fieldList, fieldSearch, 0);

            if (baseChildRels && baseChildRels.length > 0) {
                renderChildRelList(baseChildRels, '', relList, relSearch);
            } else {
                relList.innerHTML = '<div style="padding:10px; color:#888; text-align:center; font-size:12px;">No child relationships</div>';
            }
        }

        function renderFieldList(fields, path, container, search, depth) {
            fields.filter(f => !search || f.name.toLowerCase().includes(search) || (f.label && f.label.toLowerCase().includes(search)))
            .forEach(f => {
                const fullPath = path ? path + '.' + f.name : f.name;
                const relationshipPath = path ? path + '.' + f.relationshipName : f.relationshipName;

                const div = document.createElement('div');
                div.className = 'field-item';
                
                if (f.type === 'reference' && f.relationshipName) {
                    const expander = document.createElement('span');
                    expander.className = 'expander' + (depth >= 5 ? ' disabled' : '');
                    expander.textContent = relData[relationshipPath] ? '−' : '+';
                    if (depth < 5) expander.onclick = () => toggleRelationship(f.referenceTo[0], relationshipPath, 'field');
                    div.appendChild(expander);
                } else {
                    const spacer = document.createElement('div');
                    spacer.style.width = '14px';
                    div.appendChild(spacer);
                }

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.id = 'f_' + fullPath;
                cb.checked = selectedFields.has(fullPath);
                cb.onchange = (e) => {
                    if(e.target.checked) selectedFields.add(fullPath);
                    else selectedFields.delete(fullPath);
                    updateQuery();
                };
                
                const label = document.createElement('label');
                label.htmlFor = 'f_' + fullPath;
                label.textContent = f.name;
                label.title = \`\${f.label || ''} (\${f.type})\`;
                
                div.appendChild(cb);
                div.appendChild(label);
                container.appendChild(div);

                if (relData[relationshipPath]) {
                    const subContainer = document.createElement('div');
                    subContainer.className = 'rel-container';
                    renderFieldList(relData[relationshipPath].fields, relationshipPath, subContainer, search, depth + 1);
                    container.appendChild(subContainer);
                }
            });
        }

        function renderChildRelList(rels, path, container, search) {
            rels.filter(r => !search || r.relationshipName.toLowerCase().includes(search))
            .forEach(r => {
                const relPath = path ? path + '.' + r.relationshipName : r.relationshipName;
                const div = document.createElement('div');
                div.className = 'field-item';

                const expander = document.createElement('span');
                expander.className = 'expander';
                expander.textContent = relData[relPath] ? '−' : '+';
                expander.onclick = () => toggleRelationship(r.childSObject, relPath, 'rel');
                
                const label = document.createElement('label');
                label.style.fontWeight = 'bold';
                label.style.color = 'var(--vscode-symbolIcon-enumeratorForeground)';
                label.textContent = r.relationshipName;

                div.appendChild(expander);
                div.appendChild(label);
                container.appendChild(div);

                if (relData[relPath]) {
                    const subContainer = document.createElement('div');
                    subContainer.className = 'rel-container';
                    renderFieldList(relData[relPath].fields, relPath, subContainer, search, 0);
                    container.appendChild(subContainer);
                }
            });
        }

        function toggleRelationship(sobject, path, type) {
            if (relData[path]) {
                delete relData[path];
                renderFields();
            } else {
                document.getElementById(type === 'field' ? 'fields-loading' : 'rel-loading').style.display = 'flex';
                vscode.postMessage({ command: 'describeObject', sobject, parentPath: path });
            }
        }
        
        function updateQuery() {
            if(!currentObject) return;
            const childRelNames = baseChildRels.map(r => r.relationshipName);
            const standardFields = [];
            const subqueries = {};

            Array.from(selectedFields).forEach(fullPath => {
                const parts = fullPath.split('.');
                if (childRelNames.includes(parts[0])) {
                    const relName = parts[0];
                    if (!subqueries[relName]) subqueries[relName] = [];
                    subqueries[relName].push(parts.slice(1).join('.') || 'Id');
                } else {
                    standardFields.push(fullPath);
                }
            });

            let fieldsStr = standardFields.join(', ') || 'Id';
            Object.keys(subqueries).forEach(relName => {
                fieldsStr += \`, (SELECT \${subqueries[relName].join(', ')} FROM \${relName})\`;
            });

            document.getElementById('soql-query').value = \`SELECT \${fieldsStr} FROM \${currentObject} LIMIT 2000\`;
        }
        
        function runQuery() {
            const q = document.getElementById('soql-query').value;
            if(!q) return;
            document.getElementById('results-list').innerHTML = '<div class="spinner-container"><div class="spinner"></div></div>';
            document.getElementById('query-loading').style.display = 'flex';
            vscode.postMessage({ command: 'runQuery', query: q });
        }

        function copyQuery() {
            const q = document.getElementById('soql-query').value;
            if(!q) return;
            const el = document.createElement('textarea'); el.value = q; document.body.appendChild(el);
            el.select(); document.execCommand('copy'); document.body.removeChild(el);
            vscode.postMessage({ command: 'showWarning', text: 'Query copied to clipboard' });
        }
        
        function renderResults() {
            const list = document.getElementById('results-list');
            list.innerHTML = '';
            if(!allResults || allResults.length === 0) {
                list.innerHTML = '<div style="padding:20px; text-align:center;">No results found.</div>';
                document.getElementById('pagination').style.display = 'none';
                return;
            }

            const total = allResults.length;
            const start = (currentPage - 1) * pageSize;
            const end = Math.min(start + pageSize, total);
            const pageData = allResults.slice(start, end);

            document.getElementById('pagination').style.display = 'flex';
            document.getElementById('pagination-info').textContent = \`Showing \${start + 1}-\${end} of \${total} (Page \${currentPage} / \${Math.ceil(total / pageSize)})\`;
            document.getElementById('prev-btn').disabled = currentPage === 1;
            document.getElementById('next-btn').disabled = end >= total;

            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const tbody = document.createElement('tbody');
            
            const cols = extractColumns(pageData);
            const trHead = document.createElement('tr');
            cols.forEach(c => {
                const th = document.createElement('th');
                th.textContent = c;
                trHead.appendChild(th);
            });
            thead.appendChild(trHead);
            
            pageData.forEach(r => {
                const tr = document.createElement('tr');
                cols.forEach(c => {
                    const td = document.createElement('td');
                    const val = getValueByPath(r, c);
                    
                    if (c.endsWith(' (Subquery)')) {
                        const relName = c.replace(' (Subquery)', '');
                        const subData = r[relName];
                        if (subData && subData.records) {
                            td.className = 'subquery-cell';
                            
                            const info = document.createElement('span');
                            info.className = 'subquery-count';
                            info.textContent = \`\${subData.totalSize} records\`;
                            td.appendChild(info);

                            const btnDiv = document.createElement('div');
                            btnDiv.className = 'subquery-btn-row';

                            const viewBtn = document.createElement('button');
                            viewBtn.className = 'btn-blue';
                            viewBtn.innerHTML = 'View';
                            viewBtn.onclick = () => vscode.postMessage({ 
                                command: 'openSubqueryResult', 
                                data: subData.records 
                            });
                            
                            const jsonBtn = document.createElement('button');
                            jsonBtn.className = 'btn-blue';
                            jsonBtn.innerHTML = 'JSON';
                            jsonBtn.onclick = () => vscode.postMessage({ 
                                command: 'saveFile', 
                                content: JSON.stringify(subData.records, null, 2), 
                                fileName: \`\${relName}_\${r.Id || 'record'}.json\` 
                            });
                            
                            btnDiv.appendChild(viewBtn);
                            btnDiv.appendChild(jsonBtn);
                            td.appendChild(btnDiv);
                        }
                    } else {
                        td.textContent = (val === null || val === undefined) ? '' : (typeof val === 'object' ? JSON.stringify(val) : val);
                    }
                    if (c === 'Id' && val) {
                        td.innerHTML = \`<span class="id-link">\${val}</span>\`;
                        td.addEventListener('click', (e) => {
                            e.stopPropagation(); // Prevent document click from closing it immediately
                            if (isTooling) {
                                vscode.postMessage({ command: 'openBrowser', recordId: val });
                            } else {
                                const type = r.attributes && r.attributes.type ? r.attributes.type : currentObject;
                                showContextMenu(e.clientX, e.clientY, val, r, type);
                            }
                        });
                    }
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            
            table.appendChild(thead); table.appendChild(tbody); list.appendChild(table);
            
            // Add global click listener to hide context menu
            document.addEventListener('click', () => {
                const menu = document.getElementById('custom-context-menu');
                if(menu) menu.style.display = 'none';
            });
        }

        function extractColumns(records) {
            const columns = new Set();
            const subqueryKeys = new Set();
            records.forEach(r => {
                Object.keys(r).forEach(k => {
                    if (k === 'attributes') return;
                    if (r[k] !== null && typeof r[k] === 'object') {
                        if (Array.isArray(r[k]) || r[k].records) {
                            columns.add(k + ' (Subquery)');
                            subqueryKeys.add(k);
                        } else {
                            Object.keys(r[k]).forEach(subK => { if (subK !== 'attributes') columns.add(k + '.' + subK); });
                        }
                    } else { columns.add(k); }
                });
            });
            // Final deduplication: remove any key that already has a (Subquery) version
            // AND remove any key 'X' if 'X.Y' exists (hides parent object JSON column)
            const colsArray = Array.from(columns);
            return colsArray.filter(c => !subqueryKeys.has(c) && !colsArray.some(other => other.startsWith(c + '.') && other !== c));
        }

        function getValueByPath(obj, path) {
            if (path.includes(' (Subquery)')) return null;
            return path.split('.').reduce((acc, part) => acc && acc[part], obj);
        }

        function nextPage() { currentPage++; renderResults(); }
        function prevPage() { currentPage--; renderResults(); }
        function jumpToPage() {
            const val = parseInt(document.getElementById('jump-page-input').value);
            if(val >= 1 && val <= Math.ceil(allResults.length/pageSize)) { currentPage = val; renderResults(); }
        }
        function updatePageSize() {
            pageSize = parseInt(document.getElementById('page-size-select').value);
            currentPage = 1; renderResults();
        }

        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            const idx = tabName === 'builder' ? 0 : 1;
            document.querySelectorAll('.tab')[idx].classList.add('active');
            document.getElementById('tab-' + tabName).classList.add('active');
        }

        function exportData(format, action) {
            if(!allResults || allResults.length === 0) return;
            const separator = format === 'csv' ? ',' : '\\t';
            const cols = extractColumns(allResults).filter(c => !c.endsWith(' (Subquery)'));
            let content = cols.join(separator) + '\\n';
            allResults.forEach(r => {
                content += cols.map(c => \`"\${String(getValueByPath(r, c) || '').replace(/"/g, '""')}"\`).join(separator) + '\\n';
            });
            if (action === 'copy') {
                const el = document.createElement('textarea'); el.value = content; document.body.appendChild(el);
                el.select(); document.execCommand('copy'); document.body.removeChild(el);
                vscode.postMessage({ command: 'showWarning', text: 'Copied to clipboard' });
            } else {
                vscode.postMessage({ command: 'saveFile', content, fileName: \`export.\${format === 'csv' ? 'csv' : 'xls'}\` });
            }
        }
    </script>
    
    <div id="custom-context-menu" class="custom-context-menu">
        <div class="menu-item" id="ctx-view-details">View Details (All Fields)</div>
        <div class="menu-item" id="ctx-open-browser">Open in Browser</div>
    </div>
    <script>
        function showContextMenu(x, y, recordId, fullRecord, sobjectType) {
            const menu = document.getElementById('custom-context-menu');
            menu.style.display = 'block';
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
            
            // Set actions
            const viewDetails = document.getElementById('ctx-view-details');
            const openBrowser = document.getElementById('ctx-open-browser');
            
            // Clone to remove old listeners
            const newView = viewDetails.cloneNode(true);
            const newOpen = openBrowser.cloneNode(true);
            viewDetails.parentNode.replaceChild(newView, viewDetails);
            openBrowser.parentNode.replaceChild(newOpen, openBrowser);
            
            newView.onclick = () => {
                vscode.postMessage({ command: 'viewDetails', data: { Id: recordId }, sobject: sobjectType });
                menu.style.display = 'none';
            };
            
            newOpen.onclick = () => {
                vscode.postMessage({ command: 'openBrowser', recordId: recordId });
                menu.style.display = 'none';
            };
        }
    </script>
</body>
</html>
`;
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
