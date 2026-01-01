import * as vscode from 'vscode';
import { SfCli } from '../sfCli';

export class ApexLogsPanel {
    public static currentPanel: ApexLogsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _sfCli: SfCli;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._sfCli = new SfCli();

        this._update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'getLogs':
                        this._refreshLogs();
                        return;

                    case 'openLog':
                        this._openLog(message.logId);
                        return;

                    case 'downloadLogs':
                        this._downloadLogs(message.logIds);
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

        if (ApexLogsPanel.currentPanel) {
            ApexLogsPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'sfDevToolsApexLogs',
            'Apex Logs',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: []
            }
        );

        ApexLogsPanel.currentPanel = new ApexLogsPanel(panel, extensionUri);
    }

    public dispose() {
        ApexLogsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _refreshLogs() {
        try {
            const logs = await this._sfCli.getApexLogs();
            this._panel.webview.postMessage({ command: 'setLogs', logs });
        } catch (e) {
            vscode.window.showErrorMessage(`Error fetching logs: ${e}`);
        }
    }

    private async _openLog(logId: string) {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Opening Log ${logId}...`,
            cancellable: false
        }, async () => {
            try {
                const content = await this._sfCli.getApexLogContent(logId);
                const doc = await vscode.workspace.openTextDocument({ content, language: 'apex-log' });
                await vscode.window.showTextDocument(doc);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to open log: ${e.message}`);
            }
        });
    }

    private async _downloadLogs(logIds: string[]) {
        if (!logIds || logIds.length === 0) {
            vscode.window.showWarningMessage("No logs selected.");
            return;
        }

        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Download Folder'
        });

        if (uri && uri[0]) {
            const outputDir = uri[0].fsPath;
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Downloading ${logIds.length} logs...`,
                cancellable: true
            }, async (progress, token) => {
                let successCount = 0;
                let failCount = 0;
                let lastError = '';
                
                for (let i = 0; i < logIds.length; i++) {
                    if (token.isCancellationRequested) break;
                    
                    const id = logIds[i];
                    progress.report({ message: `Log ${i + 1}/${logIds.length} (${id})`, increment: (100 / logIds.length) });
                    
                    try {
                        await this._sfCli.downloadApexLog(id, outputDir);
                        successCount++;
                    } catch (e: any) {
                        failCount++;
                        lastError = e.message || e;
                        console.error(`Failed to download ${id}:`, e);
                    }
                }
                
                if (failCount === 0) {
                    vscode.window.showInformationMessage(`Successfully downloaded ${successCount} logs to ${outputDir}`);
                } else {
                    vscode.window.showWarningMessage(`Downloaded ${successCount} logs. Failed: ${failCount}. Last error: ${lastError}`);
                }
            });
        }
    }

    private _update() {
        this._panel.title = "Apex Logs";
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
    <title>Apex Logs</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background-color: var(--vscode-editor-background); }
        h2 { margin-top: 0; }
        .controls { margin-bottom: 20px; display: flex; gap: 10px; align-items: center; }
        
        button { background-color: #0078d4; color: #ffffff; border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px; }
        button:hover { background-color: #106ebe; }
        button.secondary { background-color: #0078d4; color: #ffffff; }
        button.secondary:hover { background-color: #106ebe; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }

        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
        th { background-color: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
        tr:hover { background-color: var(--vscode-list-hoverBackground); }

        tr:hover { background-color: var(--vscode-list-hoverBackground); }
        
        .loading-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.1); display: none; justify-content: center; align-items: center; z-index: 1000; }
        .spinner { border: 3px solid rgba(0, 120, 212, 0.2); border-top: 3px solid #0078d4; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; margin-right: 10px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .loading-text { font-size: 14px; font-weight: 600; }
    </style>
</head>
<body>
    <div id="loading" class="loading-overlay">
        <div class="spinner"></div>
        <span class="loading-text">Loading Logs...</span>
    </div>

    <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2>Apex Debug Logs</h2>
        <div class="controls">
             <button class="secondary" onclick="downloadSelected()" id="btn-download" disabled>Download Selected</button>
             <button onclick="refreshLogs()">Refresh</button>
        </div>
    </div>

    <table id="logs-table">
        <thead>
            <tr>
                <th style="width: 30px"><input type="checkbox" id="select-all"></th>
                <th>Start Time</th>
                <th>User</th>
                <th>Operation</th>
                <th>Status</th>
                <th>Duration (ms)</th>
                <th>Size (bytes)</th>
                <th>Action</th>
            </tr>
        </thead>
        <tbody>
            <!-- Logs here -->
        </tbody>
    </table>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let currentLogs = [];
        let selectedLogs = new Set();
        
        window.addEventListener('message', event => {
            const message = event.data;
            switch(message.command) {
                case 'setLogs':
                    currentLogs = message.logs;
                    renderLogs();
                    document.getElementById('loading').style.display = 'none';
                    break;
            }
        });

        function refreshLogs() {
            console.log('Button Clicked: refreshLogs');
            document.getElementById('loading').style.display = 'flex';
            selectedLogs.clear();
            updateButtons();
            vscode.postMessage({ command: 'getLogs' });
        }

        // Initial Load
        refreshLogs();

        function renderLogs() {
            const tbody = document.querySelector('#logs-table tbody');
            tbody.innerHTML = '';
            
            if(currentLogs.length === 0) {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td colspan="8" style="text-align:center; padding: 20px;">No logs found.</td>';
                tbody.appendChild(tr);
                return;
            }

            currentLogs.forEach(log => {
                const tr = document.createElement('tr');
                
                const user = (typeof log.LogUser === 'string') ? log.LogUser : (log.LogUser ? log.LogUser.Name : 'Unknown');
                const time = new Date(log.StartTime).toLocaleString();

                tr.innerHTML = \`
                    <td><input type="checkbox" class="log-cb" data-id="\${log.Id}"></td>
                    <td>\${time}</td>
                    <td>\${user}</td>
                    <td>\${log.Operation}</td>
                    <td>\${log.Status}</td>
                    <td>\${log.DurationMilliseconds}</td>
                    <td>\${log.LogLength}</td>
                    <td><button style="padding: 4px 8px; font-size:12px;" onclick="openLog('\${log.Id}')">View</button></td>
                \`;
                tbody.appendChild(tr);
            });

            // Re-bind events
            document.querySelectorAll('.log-cb').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const id = e.target.getAttribute('data-id');
                    if(e.target.checked) selectedLogs.add(id);
                    else selectedLogs.delete(id);
                    updateButtons();
                });
            });
        }
        
        document.getElementById('select-all').addEventListener('change', (e) => {
            const checked = e.target.checked;
            document.querySelectorAll('.log-cb').forEach(cb => {
                cb.checked = checked;
                const id = cb.getAttribute('data-id');
                if(checked) selectedLogs.add(id);
                else selectedLogs.delete(id);
            });
            updateButtons();
        });

        function updateButtons() {
            const btn = document.getElementById('btn-download');
            btn.disabled = selectedLogs.size === 0;
            btn.textContent = selectedLogs.size > 0 ? \`Download Selected (\${selectedLogs.size})\` : 'Download Selected';
        }

        function openLog(id) {
            console.log('Button Clicked: openLog', id);
            vscode.postMessage({ command: 'openLog', logId: id });
        }

        function downloadSelected() {
            console.log('Button Clicked: downloadSelected');
            const ids = Array.from(selectedLogs);
            if(ids.length > 0) {
                vscode.postMessage({ command: 'downloadLogs', logIds: ids });
            }
        }
    </script>
</body>
</html>`;
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
