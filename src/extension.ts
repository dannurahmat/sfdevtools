import * as vscode from 'vscode';
import { SfCli } from './sfCli';
import { MetadataBrowserPanel } from './panels/MetadataBrowserPanel';
import { ApexLogsPanel } from './panels/ApexLogsPanel';
import { SoqlBuilderPanel } from './panels/SoqlBuilderPanel';
import { GraphqlBuilderPanel } from './panels/GraphqlBuilderPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('SF DevTools is now active!');
    const sfCli = new SfCli();

    // Commands
    let refreshDisposable = vscode.commands.registerCommand('sfdevtools.refreshOrg', () => {
        orgProvider.refresh();
    });

    let loginDisposable = vscode.commands.registerCommand('sfdevtools.login', async () => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Logging in to Salesforce...",
            cancellable: true
        }, async () => {
             try {
                 await sfCli.login();
                 vscode.window.showInformationMessage("Successfully logged in.");
                 orgProvider.refresh();
             } catch (err: any) {
                 vscode.window.showErrorMessage(`Login failed: ${err.message}`);
             }
        });
    });

    let openBrowserDisposable = vscode.commands.registerCommand('sfdevtools.openMetadataBrowser', () => {
        MetadataBrowserPanel.createOrShow(context.extensionUri);
    });

    // Simple TreeView provider for the sidebar to just show a button?
    // For now, let's just make the "view" contribute the command in the Welcome content or just an empty tree that has buttons.
    // Or we can register a TreeDataProvider. 
    // To make it simple as requested "click on there and select", we can just have the "Open Metadata Browser" button in the view welcome content.
    // We don't need a full TreeDataProvider if we just want a launch point.
    // But to satisfy "views" contribution we need a provider or welcome view.
    
    // Let's implement a minimal TreeDataProvider that just has one item "Open Browser"
    // Dynamic Tree Data Provider
    // 1. Tools Provider
    class ToolsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
        getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
            return element;
        }

        async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
            if (!element) {
                const items: vscode.TreeItem[] = [];
                
                const openBrowser = new vscode.TreeItem("Open Metadata Browser", vscode.TreeItemCollapsibleState.None);
                openBrowser.command = { command: 'sfdevtools.openMetadataBrowser', title: "Open" };
                openBrowser.iconPath = new vscode.ThemeIcon('browser');
                items.push(openBrowser);

                const soqlBuilder = new vscode.TreeItem("Records Query (SOQL)", vscode.TreeItemCollapsibleState.None);
                soqlBuilder.command = { command: 'sfdevtools.openSoqlBuilder', title: "Records Query" };
                soqlBuilder.iconPath = new vscode.ThemeIcon('database');
                items.push(soqlBuilder);

                const toolingQuery = new vscode.TreeItem("Tooling Query", vscode.TreeItemCollapsibleState.None);
                toolingQuery.command = { command: 'sfdevtools.openToolingQuery', title: "Tooling Query" };
                toolingQuery.iconPath = new vscode.ThemeIcon('tools');
                items.push(toolingQuery);

                const graphqlBuilder = new vscode.TreeItem("GraphQL Builder", vscode.TreeItemCollapsibleState.None);
                graphqlBuilder.command = { command: 'sfdevtools.openGraphqlBuilder', title: "GraphQL Builder" };
                graphqlBuilder.iconPath = new vscode.ThemeIcon('graph');
                items.push(graphqlBuilder);

                const openApexLogs = new vscode.TreeItem("Open Apex Logs", vscode.TreeItemCollapsibleState.None);
                openApexLogs.command = { command: 'sfdevtools.openApexLogs', title: "Open Apex Logs" };
                openApexLogs.iconPath = new vscode.ThemeIcon('file-code');
                items.push(openApexLogs);

                return items;
            }
            return [];
        }
    }

    // 2. Org Connection Provider
    class OrgTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
        private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
        readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

        refresh(): void {
            this._onDidChangeTreeData.fire();
        }

        getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
            return element;
        }

        async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
            if (!element) {
                const items: vscode.TreeItem[] = [];
                const currentOrg = await sfCli.getDefaultOrg();
                
                if (currentOrg) {
                    // Connected State - Show Info
                    const orgDisplay = await sfCli.getOrgDisplay();
                    
                    if (orgDisplay) {
                        const aliasItem = new vscode.TreeItem(`Alias: ${orgDisplay.alias || 'N/A'}`, vscode.TreeItemCollapsibleState.None);
                        aliasItem.command = { command: 'sfdevtools.copyToClipboard', title: "Copy Alias", arguments: [orgDisplay.alias || '', 'Alias'] };
                        aliasItem.tooltip = "Click to copy Alias";
                        items.push(aliasItem);

                        const usernameItem = new vscode.TreeItem(`Username: ${orgDisplay.username}`, vscode.TreeItemCollapsibleState.None);
                        usernameItem.command = { command: 'sfdevtools.copyToClipboard', title: "Copy Username", arguments: [orgDisplay.username, 'Username'] };
                        usernameItem.tooltip = "Click to copy Username";
                        items.push(usernameItem);

                        const hostItem = new vscode.TreeItem(`Host: ${orgDisplay.instanceUrl}`, vscode.TreeItemCollapsibleState.None);
                        hostItem.iconPath = new vscode.ThemeIcon('globe');
                        hostItem.command = { command: 'sfdevtools.copyToClipboard', title: "Copy Host", arguments: [orgDisplay.instanceUrl, 'Host URL'] };
                        hostItem.tooltip = "Click to copy Host URL";
                        items.push(hostItem);

                        const idItem = new vscode.TreeItem(`Org ID: ${orgDisplay.id}`, vscode.TreeItemCollapsibleState.None);
                        idItem.iconPath = new vscode.ThemeIcon('key'); 
                        idItem.command = { command: 'sfdevtools.copyToClipboard', title: "Copy Org ID", arguments: [orgDisplay.id, 'Org ID'] };
                        idItem.tooltip = "Click to copy Org ID";
                        items.push(idItem);

                        // Actions
                        const copyToken = new vscode.TreeItem("Copy Access Token", vscode.TreeItemCollapsibleState.None);
                        copyToken.command = { command: 'sfdevtools.copyAccessToken', title: "Copy Access Token", arguments: [orgDisplay.accessToken] };
                        copyToken.iconPath = new vscode.ThemeIcon('copy');
                        items.push(copyToken);

                        const copyAuthUrl = new vscode.TreeItem("Copy Sfdx Auth URL", vscode.TreeItemCollapsibleState.None);
                        copyAuthUrl.command = { command: 'sfdevtools.copySfdxAuthUrl', title: "Copy Sfdx Auth URL", arguments: [orgDisplay.sfdxAuthUrl] };
                        copyAuthUrl.iconPath = new vscode.ThemeIcon('link');
                        items.push(copyAuthUrl);
                    } else {
                         // Fallback
                         const orgInfo = new vscode.TreeItem(`Org: ${currentOrg}`, vscode.TreeItemCollapsibleState.None);
                         orgInfo.iconPath = new vscode.ThemeIcon('plug');
                         items.push(orgInfo);
                    }

                    const connectOther = new vscode.TreeItem("Connect to others orgs...", vscode.TreeItemCollapsibleState.None);
                    connectOther.command = { command: 'sfdevtools.connectOrg', title: "Connect to other orgs" };
                    connectOther.iconPath = new vscode.ThemeIcon('hubot'); 
                    items.push(connectOther);
                } else {
                    // Not Connected State
                    const login = new vscode.TreeItem("Login to Org", vscode.TreeItemCollapsibleState.None);
                    login.command = { command: 'sfdevtools.login', title: "Login" };
                    login.iconPath = new vscode.ThemeIcon('key');
                    items.push(login);
                }

                const openOrg = new vscode.TreeItem("Open Org in Browser", vscode.TreeItemCollapsibleState.None);
                openOrg.command = { command: 'sfdevtools.openOrg', title: "Open Org" };
                openOrg.iconPath = new vscode.ThemeIcon('browser');
                items.push(openOrg);

                // Always show Refresh
                const refresh = new vscode.TreeItem("Refresh Org Connection", vscode.TreeItemCollapsibleState.None);
                refresh.command = { command: 'sfdevtools.refreshOrg', title: "Refresh" };
                refresh.iconPath = new vscode.ThemeIcon('refresh');
                items.push(refresh);

                return items;
            }
            return [];
        }
    }
    
    // Register Providers
    const toolsProvider = new ToolsTreeProvider();
    vscode.window.registerTreeDataProvider('sfdevtools-view', toolsProvider);

    const orgProvider = new OrgTreeProvider();
    vscode.window.registerTreeDataProvider('sfdevtools-org', orgProvider);

    // Update refresh command to refresh org provider
    refreshDisposable.dispose();
    refreshDisposable = vscode.commands.registerCommand('sfdevtools.refreshOrg', () => {
        orgProvider.refresh();
    });

    // Generic Copy Command
    vscode.commands.registerCommand('sfdevtools.copyToClipboard', async (text: string, label: string) => {
        if (text) {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage(`${label} copied to clipboard!`);
        }
    });

    // Specific Copy Commands (Delegate to generic if possible or keep specific logic)
    vscode.commands.registerCommand('sfdevtools.copyAccessToken', async (token: string) => {
        vscode.commands.executeCommand('sfdevtools.copyToClipboard', token, 'Access Token');
    });

    vscode.commands.registerCommand('sfdevtools.copySfdxAuthUrl', async (url: string) => {
        vscode.commands.executeCommand('sfdevtools.copyToClipboard', url, 'Sfdx Auth URL');
    });

    // New Command: Connect Org
    let connectOrgDisposable = vscode.commands.registerCommand('sfdevtools.connectOrg', async () => {
        
        let orgList: any[] = [];
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Fetching list of authorized orgs...",
            cancellable: true
        }, async (progress, token) => {
             orgList = await sfCli.getOrgList();
        });

        // Prepare QuickPick items
        const items = orgList.map((org: any) => {
            const isDefault = org.isDefaultUsername ? '(Current) ' : '';
            return {
                label: `$(plug) ${isDefault}${org.alias || ''} [${org.username}]`,
                description: org.status,
                detail: org.isDefaultUsername ? 'Currently connected org' : 'Click to switch to this org',
                action: 'switch',
                value: org.username || org.alias
            };
        });

        // Add "Authorize New" option
        items.unshift({
            label: '$(plus) Authorize a New Org',
            description: '',
            detail: 'Log in to a new Salesforce environment',
            action: 'login',
            value: ''
        });

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select an org to switch to, or authorize a new one'
        });

        if (selection) {
            if (selection.action === 'login') {
                vscode.commands.executeCommand('sfdevtools.login');
            } else if (selection.action === 'switch') {
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Switching to ${selection.value}...`,
                    cancellable: false
                }, async () => {
                    try {
                        await sfCli.setTargetOrg(selection.value);
                        vscode.window.showInformationMessage(`Switched to org: ${selection.value}`);
                        orgProvider.refresh();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to switch org: ${e.message}`);
                    }
                });
            }
        }
    });
    context.subscriptions.push(connectOrgDisposable);

    // Original openSoqlDisposable
    // let openSoqlDisposable = vscode.commands.registerCommand('sfdevtools.openSoqlBuilder', () => {
    //     SoqlBuilderPanel.createOrShow(context.extensionUri, 'data');
    // });
    // context.subscriptions.push(openSoqlDisposable);

    // Original openToolingQueryDisposable
    // let openToolingQueryDisposable = vscode.commands.registerCommand('sfdevtools.openToolingQuery', () => {
    //     SoqlBuilderPanel.createOrShow(context.extensionUri, 'tooling');
    // });
    // context.subscriptions.push(openToolingQueryDisposable);

    // Original openApexLogsDisposable
    // let openApexLogsDisposable = vscode.commands.registerCommand('sfdevtools.openApexLogs', () => {
    //     ApexLogsPanel.createOrShow(context.extensionUri);
    // });
    // context.subscriptions.push(openApexLogsDisposable);

    context.subscriptions.push(
        vscode.commands.registerCommand('sfdevtools.openSoqlBuilder', () => {
            SoqlBuilderPanel.createOrShow(context.extensionUri, 'data');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sfdevtools.openToolingQuery', () => {
            SoqlBuilderPanel.createOrShow(context.extensionUri, 'tooling');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sfdevtools.openGraphqlBuilder', () => {
            GraphqlBuilderPanel.createOrShow(context.extensionUri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sfdevtools.openApexLogs', () => {
            ApexLogsPanel.createOrShow(context.extensionUri);
        })
    );

    let openOrgDisposable = vscode.commands.registerCommand('sfdevtools.openOrg', () => {
        sfCli.openOrg();
    });
    context.subscriptions.push(openOrgDisposable);

    context.subscriptions.push(refreshDisposable);
    context.subscriptions.push(loginDisposable);
}

export function deactivate() {}
