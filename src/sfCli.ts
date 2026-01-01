import * as cp from 'child_process';
import * as util from 'util';
import * as vscode from 'vscode';
import { OutputChannel } from './utils/outputChannel';


const exec = util.promisify(cp.exec);

export class SfCli {
    
    private static _metadataCache: string[] | undefined;

    private getCwd(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    }

    public async getDefaultOrg(): Promise<string | undefined> {
        try {
            const cwd = this.getCwd();
            const { stdout } = await exec('sf config get target-org --json', { cwd });
            const result = JSON.parse(stdout);
            
            if (result.status === 0 && result.result && result.result.length > 0) {
                return result.result[0].value; 
            }
            return undefined;
        } catch (error) {
            console.error('Error getting default org:', error);
            return undefined;
        }
    }

    public async login(): Promise<void> {
        SfCli._metadataCache = undefined; // Clear cache on new login
        const cwd = this.getCwd();
        // --set-default-dev-hub is optional, usually just --set-default is enough for project work
        await exec('sf org login web --set-default --json', { cwd });
    }

    public async openOrg(): Promise<void> {
        const cwd = this.getCwd();
        try {
            await exec('sf org open', { cwd });
        } catch (error) {
            console.error('Error opening org:', error);
            vscode.window.showErrorMessage('Failed to open org in browser.');
        }
    }

    public async getOrgList(): Promise<{ alias: string, username: string, status: string, isDefaultDevHubUsername?: boolean, isDefaultUsername?: boolean }[]> {
        const cwd = this.getCwd();
        try {
            const { stdout } = await exec('sf org list --json', { cwd });
            const result = JSON.parse(stdout);
            if (result.status === 0 && result.result) {
                // result.result has nonScratchOrgs, scratchOrgs, etc.
                const allOrgs = [
                    ...(result.result.nonScratchOrgs || []),
                    ...(result.result.scratchOrgs || [])
                ];
                return allOrgs;
            }
            return [];
        } catch (error) {
            console.error('Error fetching org list:', error);
            return [];
        }
    }

    public async setTargetOrg(usernameOrAlias: string): Promise<void> {
        SfCli._metadataCache = undefined; // Clear cache on switch
        const cwd = this.getCwd();
        try {
            await exec(`sf config set target-org ${usernameOrAlias} --json`, { cwd });
        } catch (error: any) {
            console.error(`Error setting target org to ${usernameOrAlias}:`, error);
            throw error;
        }
    }

    public async describeMetadata(refresh: boolean = false): Promise<string[]> {
        if (!refresh && SfCli._metadataCache) {
            return SfCli._metadataCache;
        }

        const cwd = this.getCwd();
        const cmd = 'sf org list metadata-types --json';
        try {
            // Need to set maxBuffer for large metadata lists
            const { stdout } = await exec(cmd, { cwd, maxBuffer: 1024 * 1024 * 10 });
            const result = JSON.parse(stdout);
            if (result.status === 0 && result.result && result.result.metadataObjects) {
                const types = new Set<string>();
                result.result.metadataObjects.forEach((obj: any) => {
                    if (obj.xmlName) {
                        types.add(obj.xmlName);
                        if (Array.isArray(obj.childXmlNames)) {
                            obj.childXmlNames.forEach((child: string) => types.add(child));
                        }
                    }
                });
                SfCli._metadataCache = Array.from(types).sort();
                return SfCli._metadataCache;
            }
            return [];
        } catch (error) {
            console.error('Failed to describe metadata:', error);
            return [];
        }
    }

    public async listMetadata(type: string): Promise<{ fullName: string, id: string }[]> {
        const cwd = this.getCwd();
        try {
            const { stdout } = await exec(`sf org list metadata -m "${type}" --json`, { cwd, maxBuffer: 1024 * 1024 * 50 });
            const result = JSON.parse(stdout);
            if (result.status === 0 && Array.isArray(result.result)) {
                return result.result.map((item: any) => ({
                    fullName: item.fullName,
                    id: item.id
                }));
            }
            return [];
        } catch (error) {
            console.error(`Error listing metadata for ${type}:`, error);
            return [];
        }
    }

    public async getOrgApiVersion(): Promise<string> {
        const display = await this.getOrgDisplay();
        return display?.apiVersion || '62.0';
    }

    public async getOrgDisplay(): Promise<any> {
        const cwd = this.getCwd();
        try {
            // Using --verbose to get sfdxAuthUrl and accessToken
            const { stdout } = await exec('sf org display --verbose --json', { cwd });
            const result = JSON.parse(stdout);
            if (result.status === 0 && result.result) {
                return result.result;
            }
            return null;
        } catch (e) {
            console.error('Error fetching org display', e);
            return null;
        }
    }

    public async openRecordPage(recordId: string): Promise<void> {
        const cwd = this.getCwd();
        try {
            await exec(`sf org open -r ${recordId}`, { cwd });
        } catch (error) {
            console.error('Error opening record page (-r), trying path fallback:', error);
            // Fallback to path if -r fails (sometimes happens with tooling objects or specific contexts)
            try {
                await exec(`sf org open -p /${recordId}`, { cwd });
            } catch (retryError) {
                vscode.window.showErrorMessage(`Failed to open record ${recordId}: ${retryError}`);
            }
        }
    }

    public async getSingleRecord(sobject: string, recordId: string): Promise<any> {
        const cwd = this.getCwd();
        try {
            const { stdout } = await exec(`sf data get record -s ${sobject} -i ${recordId} --json`, { cwd });
            const result = JSON.parse(stdout);
            return result.result;
        } catch (error: any) {
            console.error('Error fetching single record:', error);
            throw new Error(`Failed to fetch record: ${error.message}`);
        }
    }

    public async executeGraphql(query: string): Promise<any> {
        const cwd = this.getCwd();
        try {
            const orgDisplay = await this.getOrgDisplay();
            const instanceUrl = orgDisplay.instanceUrl;
            const accessToken = orgDisplay.accessToken;
            
            if(!instanceUrl || !accessToken) {
                throw new Error('Could not retrieve Org Instance URL or Access Token.');
            }

            const url = new URL(`${instanceUrl}/services/data/v60.0/graphql`);
            const body = JSON.stringify({ query });

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            };

            return new Promise((resolve, reject) => {
                const req = require('https').request(url, options, (res: any) => {
                    let data = '';
                    res.on('data', (chunk: any) => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            if (res.statusCode >= 200 && res.statusCode < 300) {
                                resolve(json);
                            } else {
                                reject(new Error(JSON.stringify(json) || res.statusMessage));
                            }
                        } catch (e) {
                            reject(new Error(`Failed to parse GraphQL response: ${e}`));
                        }
                    });
                });
                
                req.on('error', (e: any) => reject(e));
                req.write(body);
                req.end();
            });

        } catch (error: any) {
            console.error('Error executing GraphQL:', error);
            throw error;
        }
    }

    public async retrieveMetadata(metadata: string, outputDir?: string): Promise<{ status: number, result: { files: { filePath: string }[] } }> {
        const channel = OutputChannel;
        try {
            const cwd = this.getCwd();
            let command = `sf project retrieve start -m "${metadata}" --json`;
            if (outputDir) {
                command += ` --output-dir "${outputDir}"`;
            }
            channel.appendLine(`Executing: ${command}`);
            
            const { stdout } = await exec(command, { cwd });
            channel.appendLine(`Response: ${stdout}`);
            
            return JSON.parse(stdout);
        } catch (error: any) {
             channel.appendLine(`Error: ${error.stdout || error.message}`);
             // sf throws error on partial success or failure, but result usually contains info
             if (error.stdout) {
                 return JSON.parse(error.stdout);
             }
             throw new Error(error.message);
        }
    }
    public async retrieveByManifest(manifestPath: string, outputDir?: string): Promise<{ status: number, result: { files: { filePath: string }[] } }> {
        const channel = OutputChannel;
        try {
            const cwd = this.getCwd();
            // Use resolved absolute path if possible or ensure it works from cwd
            let command = `sf project retrieve start -x "${manifestPath}" --json`;
            if (outputDir) {
                command += ` --output-dir "${outputDir}"`;
            }
            channel.appendLine(`Executing: ${command}`);
            
            const { stdout } = await exec(command, { cwd });
            channel.appendLine(`Response: ${stdout}`);
            
            return JSON.parse(stdout);
        } catch (error: any) {
             channel.appendLine(`Error: ${error.stdout || error.message}`);
             if (error.stdout) {
                 return JSON.parse(error.stdout);
             }
             throw new Error(error.message);
        }
    }

    public async listSObjects(type: 'all' | 'custom' | 'standard' = 'all'): Promise<string[]> {
        const cwd = this.getCwd();
        try {
            // sf sobject list --sobject all --json
            const { stdout } = await exec(`sf sobject list --sobject ${type} --json`, { cwd });
            const result = JSON.parse(stdout);
            if (result.status === 0 && Array.isArray(result.result)) {
                return result.result.sort();
            }
            return [];
        } catch (error) {
            console.error('Error listing sobjects:', error);
            return [];
        }
    }

    public async describeSObject(sobject: string, useToolingApi: boolean = false): Promise<{ 
        fields: { name: string, label: string, type: string, relationshipName?: string, referenceTo?: string[] }[],
        childRelationships: { relationshipName: string, childSObject: string }[]
    }> {
        const channel = OutputChannel;
        const cwd = this.getCwd();
        try {
            let command = `sf sobject describe -s ${sobject} --json`;
            if (useToolingApi) {
                command += ' -t';
            }
            channel.appendLine(`Describing Object: ${command}`);
            
            // Standard object descriptions can be large, increase buffer to 50MB
            const { stdout } = await exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 });
            const result = JSON.parse(stdout);
            
            if (result.status === 0 && result.result && Array.isArray(result.result.fields)) {
                channel.appendLine(`Found ${result.result.fields.length} fields for ${sobject}`);
                const fields = result.result.fields.map((f: any) => ({
                    name: f.name,
                    label: f.label,
                    type: f.type,
                    relationshipName: f.relationshipName,
                    referenceTo: f.referenceTo
                })).sort((a: any, b: any) => a.name.localeCompare(b.name));

                const childRelationships = Array.isArray(result.result.childRelationships) 
                    ? result.result.childRelationships
                        .filter((r: any) => r.relationshipName) // Only those with names
                        .map((r: any) => ({
                            relationshipName: r.relationshipName,
                            childSObject: r.childSObject
                        })).sort((a: any, b: any) => a.relationshipName.localeCompare(b.relationshipName))
                    : [];

                return { fields, childRelationships };
            }
            channel.appendLine(`Describe failed or no fields found: ${stdout}`);
            return { fields: [], childRelationships: [] };
        } catch (error: any) {
            channel.appendLine(`Error describing sobject ${sobject}: ${error.message}`);
             if (error.stdout) {
                  channel.appendLine(`CLI Output: ${error.stdout}`);
                 // Try to return empty to avoid crashing UI, but log it
             }
            return { fields: [], childRelationships: [] };
        }
    }

    public async executeQuery(query: string, useToolingApi: boolean = false): Promise<{ totalSize: number, records: any[] }> {
        const channel = OutputChannel;
        const cwd = this.getCwd();
        try {
            let command = `sf data query -q "${query}" --json`;
            if (useToolingApi) {
                command += ' -t';
            }
            channel.appendLine(`Executing SOQL: ${command}`);
            const { stdout } = await exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 });
            const result = JSON.parse(stdout);
            
            if (result.status === 0 && result.result) {
                return {
                    totalSize: result.result.totalSize,
                    records: result.result.records
                };
            }
            return { totalSize: 0, records: [] };
        } catch (error: any) {
            channel.appendLine(`SOQL Error: ${error.message}`);
             if (error.stdout) {
                 const res = JSON.parse(error.stdout);
                 throw new Error(res.message || "Query failed");
             }
            throw new Error(error.message);
        }
    }
    public async getApexLogs(): Promise<any[]> {
        const cwd = this.getCwd();
        try {
            const { stdout } = await exec('sf apex list log --json', { cwd });
            const result = JSON.parse(stdout);
            if (result.status === 0 && Array.isArray(result.result)) {
                return result.result;
            }
            return [];
        } catch (error) {
            console.error('Error fetching apex logs:', error);
            return [];
        }
    }

    public async getApexLogContent(logId: string): Promise<string> {
        const cwd = this.getCwd();
        const channel = OutputChannel;
        // We'll use a temp directory to save the log file
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        const tempDir = path.join(os.tmpdir(), 'sfdevtools_logs');
        
        if (!fs.existsSync(tempDir)){
            fs.mkdirSync(tempDir);
        }

        try {
            // "sf apex get log" saves to disk. 
            // We can retrieve the content by reading the file after download.
            // --output-dir puts it there. The filename is usually <ID>.log
            const command = `sf apex get log --log-id ${logId} --output-dir "${tempDir}" --json`;
            channel.appendLine(`Fetching log ${logId}: ${command}`);
            
            await exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 });
            
            // The CLI usually saves it as {logId}.log
            const filePath = path.join(tempDir, `${logId}.log`);
            
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                return content;
            } else {
                 throw new Error("Log file not found after download");
            }
        } catch (error: any) {
            channel.appendLine(`Error fetching log content: ${error.message}`);
            throw error;
        }
    }
    public async downloadApexLog(logId: string, outputDir: string): Promise<void> {
        const channel = OutputChannel;
        const path = require('path');
        const fs = require('fs');

        try {
            channel.appendLine(`Downloading log ${logId} to ${outputDir}...`);
            
            // Reuse getApexLogContent since it is proven to work (downloads to temp first)
            const content = await this.getApexLogContent(logId);
            
            const filePath = path.join(outputDir, `${logId}.log`);
            fs.writeFileSync(filePath, content);
            
            channel.appendLine(`Successfully saved log to ${filePath}`);
        } catch (error: any) {
            channel.appendLine(`Error downloading/saving log ${logId}: ${error.message}`);
            throw error;
        }
    }
}
