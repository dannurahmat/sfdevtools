import * as cp from 'child_process';
import * as util from 'util';
import * as vscode from 'vscode';
import * as https from 'https';
import { OutputChannel } from './utils/outputChannel';


const exec = util.promisify(cp.exec);

export class SfCli {
    
    private static _metadataCache: string[] | undefined;
    private static _authCache: { accessToken: string, instanceUrl: string, apiVersion: string } | undefined;

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
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const url = `${auth.instanceUrl}/secur/frontdoor.jsp?sid=${auth.accessToken}`;
            channel.appendLine(`Opening org via frontdoor URL: ${auth.instanceUrl}`);
            await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (error: any) {
            channel.appendLine(`Failed to open org via API: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                await exec('sf org open', { cwd });
            } catch (cliError) {
                console.error('CLI Fallback failed:', cliError);
                vscode.window.showErrorMessage('Failed to open org in browser.');
            }
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
        SfCli._authCache = undefined;
        const cwd = this.getCwd();
        try {
            await exec(`sf config set target-org ${usernameOrAlias} --json`, { cwd });
        } catch (error: any) {
            console.error(`Error setting target org to ${usernameOrAlias}:`, error);
            throw error;
        }
    }

    private async _getAuth(): Promise<{ accessToken: string, instanceUrl: string, apiVersion: string }> {
        if (SfCli._authCache) {
            return SfCli._authCache;
        }

        const display = await this.getOrgDisplay();
        if (!display || !display.accessToken || !display.instanceUrl) {
            throw new Error('Could not retrieve Org credentials. Ensure you are logged in.');
        }

        SfCli._authCache = {
            accessToken: display.accessToken,
            instanceUrl: display.instanceUrl,
            apiVersion: display.apiVersion || '62.0'
        };
        return SfCli._authCache;
    }

    private async _request(method: string, endpoint: string, body?: any): Promise<any> {
        const auth = await this._getAuth();
        const url = new URL(`${auth.instanceUrl}${endpoint}`);
        
        const options: https.RequestOptions = {
            method,
            headers: {
                'Authorization': `Bearer ${auth.accessToken}`,
                'Content-Type': 'application/json'
            }
        };

        return new Promise((resolve, reject) => {
            const req = https.request(url, options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        if (res.statusCode === 401) {
                            SfCli._authCache = undefined; // Force refresh on next call
                        }
                        
                        const json = data ? JSON.parse(data) : {};
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(json);
                        } else {
                            const errorMsg = Array.isArray(json) ? json[0]?.message : (json.message || res.statusMessage);
                            reject(new Error(errorMsg || `API Request failed with status ${res.statusCode}`));
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse API response: ${e}`));
                    }
                });
            });

            req.on('error', reject);
            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    public async describeMetadata(refresh: boolean = false): Promise<string[]> {
        if (!refresh && SfCli._metadataCache) {
            return SfCli._metadataCache;
        }

        try {
            const auth = await this._getAuth();
            const result = await this._request('GET', `/services/data/v${auth.apiVersion}/metadata/describeMetadata`);
            
            if (result && result.metadataObjects) {
                const types = new Set<string>();
                result.metadataObjects.forEach((obj: any) => {
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
            console.error('Failed to describe metadata via API, falling back to CLI:', error);
            // Fallback to CLI
            const cwd = this.getCwd();
            const cmd = 'sf org list metadata-types --json';
            try {
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
            } catch (cliError) {
                console.error('CLI Fallback failed:', cliError);
            }
            return [];
        }
    }

    public async listMetadata(type: string): Promise<{ fullName: string, id: string }[]> {
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const endpoint = `/services/data/v${auth.apiVersion}/metadata/listMetadata`;
            
            // listMetadata POST body
            const body = {
                queries: [{ type }]
            };

            channel.appendLine(`Listing metadata via API: ${type}`);
            const result = await this._request('POST', endpoint, body);
            
            if (Array.isArray(result)) {
                return result.map((item: any) => ({
                    fullName: item.fullName,
                    id: item.id
                }));
            }
            return [];
        } catch (error: any) {
            channel.appendLine(`API listMetadata failed: ${error.message}. Falling back to CLI.`);
            // Fallback to CLI
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
            } catch (cliError: any) {
                channel.appendLine(`CLI Fallback failed: ${cliError.message}`);
            }
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
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const url = `${auth.instanceUrl}/secur/frontdoor.jsp?sid=${auth.accessToken}&retURL=/${recordId}`;
            channel.appendLine(`Opening record ${recordId} via frontdoor URL`);
            await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (error: any) {
            channel.appendLine(`Failed to open record via API: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                await exec(`sf org open -r ${recordId}`, { cwd });
            } catch (cliError) {
                channel.appendLine(`CLI Fallback failed: ${cliError}. trying path fallback.`);
                try {
                    await exec(`sf org open -p /${recordId}`, { cwd });
                } catch (retryError) {
                    vscode.window.showErrorMessage(`Failed to open record ${recordId}: ${retryError}`);
                }
            }
        }
    }

    public async getSingleRecord(sobject: string, recordId: string): Promise<any> {
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const endpoint = `/services/data/v${auth.apiVersion}/sobjects/${sobject}/${recordId}`;
            
            channel.appendLine(`Fetching single record via API: ${sobject}/${recordId}`);
            return await this._request('GET', endpoint);
        } catch (error: any) {
            channel.appendLine(`API getSingleRecord failed: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                const { stdout } = await exec(`sf data get record -s ${sobject} -i ${recordId} --json`, { cwd });
                const result = JSON.parse(stdout);
                return result.result;
            } catch (cliError: any) {
                channel.appendLine(`CLI Fallback failed: ${cliError.message}`);
                throw new Error(`Failed to fetch record: ${cliError.message}`);
            }
        }
    }

    public async executeGraphql(query: string): Promise<any> {
        try {
            const auth = await this._getAuth();
            const endpoint = `/services/data/v${auth.apiVersion}/graphql`;
            const body = { query };

            return await this._request('POST', endpoint, body);
        } catch (error: any) {
            console.error('Error executing GraphQL:', error);
            throw error;
        }
    }

    public async retrieveMetadata(metadata: string, outputDir?: string): Promise<{ status: number, result: { files: { filePath: string }[] } }> {
        const channel = OutputChannel;
        try {
            const types = this._parseMetadataString(metadata);
            return await this._retrieveWorker({ unpackaged: { types, version: await this.getOrgApiVersion() } }, outputDir);
        } catch (error: any) {
            channel.appendLine(`API retrieveMetadata failed: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                let command = `sf project retrieve start -m "${metadata}" --json`;
                if (outputDir) command += ` --output-dir "${outputDir}"`;
                const { stdout } = await exec(command, { cwd });
                return JSON.parse(stdout);
            } catch (cliError: any) {
                if (cliError.stdout) return JSON.parse(cliError.stdout);
                throw cliError;
            }
        }
    }

    public async retrieveByManifest(manifestPath: string, outputDir?: string): Promise<{ status: number, result: { files: { filePath: string }[] } }> {
        const channel = OutputChannel;
        try {
            const manifestContent = require('fs').readFileSync(manifestPath, 'utf8');
            // Very basic manifest parsing for members and types
            const types: any[] = [];
            const typeMatches = manifestContent.matchAll(/<types>([\s\S]*?)<\/types>/g);
            for (const match of typeMatches) {
                const typeBlock = match[1];
                const name = typeBlock.match(/<name>(.*?)<\/name>/)?.[1];
                const members = [...typeBlock.matchAll(/<members>(.*?)<\/members>/g)].map(m => m[1]);
                if (name) types.push({ name, members });
            }
            
            const version = manifestContent.match(/<version>(.*?)<\/version>/)?.[1] || await this.getOrgApiVersion();
            
            return await this._retrieveWorker({ unpackaged: { types, version } }, outputDir);
        } catch (error: any) {
            channel.appendLine(`API retrieveByManifest failed: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                let command = `sf project retrieve start -x "${manifestPath}" --json`;
                if (outputDir) command += ` --output-dir "${outputDir}"`;
                const { stdout } = await exec(command, { cwd });
                return JSON.parse(stdout);
            } catch (cliError: any) {
                if (cliError.stdout) return JSON.parse(cliError.stdout);
                throw cliError;
            }
        }
    }

    private _parseMetadataString(metadata: string): any[] {
        const parts = metadata.split(',');
        const typesMap: { [key: string]: string[] } = {};
        parts.forEach(p => {
            const [type, member] = p.split(':');
            if (!typesMap[type]) typesMap[type] = [];
            typesMap[type].push(member);
        });
        return Object.entries(typesMap).map(([name, members]) => ({ name, members }));
    }

    private async _retrieveWorker(retrieveRequest: any, outputDir?: string): Promise<{ status: number, result: { files: { filePath: string }[] } }> {
        const auth = await this._getAuth();
        const apiVersion = await this.getOrgApiVersion();
        const soapUrl = `${auth.instanceUrl}/services/Soap/m/${apiVersion}`;
        
        const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
   <soapenv:Header>
      <met:SessionHeader>
         <met:sessionId>${auth.accessToken}</met:sessionId>
      </met:SessionHeader>
   </soapenv:Header>
   <soapenv:Body>
      <met:retrieve>
         <retrieveRequest>
            ${this._jsonToXml(retrieveRequest)}
         </retrieveRequest>
      </met:retrieve>
   </soapenv:Body>
</soapenv:Envelope>`;

        const headers = {
            'Content-Type': 'text/xml',
            'SOAPAction': '""'
        };

        const channel = OutputChannel;
        channel.appendLine('Initiating Metadata Retrieve via API...');

        // 1. Start Retrieve
        const initiateRes = await this._soapRequest(soapUrl, soapBody, headers);
        const asyncId = initiateRes.match(/<id>(.*?)<\/id>/)?.[1];
        if (!asyncId) throw new Error('Failed to initiate retrieve: ' + initiateRes);

        // 2. Poll Status
        let retrieveResult: any;
        for (let i = 0; i < 60; i++) { // Poll for 5 minutes
            await new Promise(resolve => setTimeout(resolve, 5000));
            const pollBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
   <soapenv:Header>
      <met:SessionHeader>
         <met:sessionId>${auth.accessToken}</met:sessionId>
      </met:SessionHeader>
   </soapenv:Header>
   <soapenv:Body>
      <met:checkRetrieveStatus>
         <asyncProcessId>${asyncId}</asyncProcessId>
         <includeZip>true</includeZip>
      </met:checkRetrieveStatus>
   </soapenv:Body>
</soapenv:Envelope>`;

            const pollRes = await this._soapRequest(soapUrl, pollBody, headers);
            const status = pollRes.match(/<status>(.*?)<\/status>/)?.[1];
            channel.appendLine(`Poll status: ${status}`);

            if (status === 'Succeeded') {
                const zipBase64 = pollRes.match(/<zipFile>(.*?)<\/zipFile>/)?.[1];
                retrieveResult = { zipBase64 };
                break;
            } else if (status === 'Failed') {
                const msg = pollRes.match(/<errorMessage>(.*?)<\/errorMessage>/)?.[1];
                throw new Error('Retrieve failed: ' + msg);
            }
        }

        if (!retrieveResult) throw new Error('Retrieve timed out.');

        // 3. Save and Unzip
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const tempZip = path.join(os.tmpdir(), `retrieve_${asyncId}.zip`);
        const tempExtractDir = path.join(os.tmpdir(), `extract_${asyncId}`);
        
        fs.writeFileSync(tempZip, Buffer.from(retrieveResult.zipBase64, 'base64'));
        if (!fs.existsSync(tempExtractDir)) fs.mkdirSync(tempExtractDir, { recursive: true });

        channel.appendLine(`Unzipping to ${tempExtractDir}...`);
        await exec(`unzip -o "${tempZip}" -d "${tempExtractDir}"`);

        // 4. Move to final destination and list files
        const finalDest = outputDir || path.join(this.getCwd()!, 'force-app', 'main', 'default');
        if (!fs.existsSync(finalDest)) fs.mkdirSync(finalDest, { recursive: true });

        // Metadata API zip structure is unpackaged/...
        const sourceDir = path.join(tempExtractDir, 'unpackaged');
        const files: { filePath: string }[] = [];

        const walk = (dir: string) => {
            const list = fs.readdirSync(dir);
            list.forEach((file: string) => {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) walk(fullPath);
                else {
                    const relative = path.relative(sourceDir, fullPath);
                    const dest = path.join(finalDest, relative);
                    const destDir = path.dirname(dest);
                    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                    fs.copyFileSync(fullPath, dest);
                    files.push({ filePath: dest });
                }
            });
        };
        if (fs.existsSync(sourceDir)) walk(sourceDir);

        // Cleanup
        fs.unlinkSync(tempZip);
        fs.rmSync(tempExtractDir, { recursive: true, force: true });

        return { status: 0, result: { files } };
    }

    private _jsonToXml(obj: any): string {
        let xml = '';
        for (const [key, value] of Object.entries(obj)) {
            if (Array.isArray(value)) {
                value.forEach(v => {
                    xml += `<${key}>${this._jsonToXml(v)}</${key}>`;
                });
            } else if (typeof value === 'object') {
                xml += `<${key}>${this._jsonToXml(value)}</${key}>`;
            } else {
                xml += `<${key}>${value}</${key}>`;
            }
        }
        return xml;
    }

    private async _soapRequest(url: string, body: string, headers: any): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const options = {
                method: 'POST',
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname,
                headers
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    public async listSObjects(type: 'all' | 'custom' | 'standard' = 'all'): Promise<string[]> {
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const endpoint = `/services/data/v${auth.apiVersion}/sobjects`;
            
            channel.appendLine(`Listing SObjects via API: ${type}`);
            const result = await this._request('GET', endpoint);
            
            if (result && Array.isArray(result.sobjects)) {
                let sobjects = result.sobjects;
                if (type === 'custom') {
                    sobjects = sobjects.filter((s: any) => s.custom);
                } else if (type === 'standard') {
                    sobjects = sobjects.filter((s: any) => !s.custom);
                }
                return sobjects.map((s: any) => s.name).sort();
            }
            return [];
        } catch (error: any) {
            channel.appendLine(`API listSObjects failed: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                const { stdout } = await exec(`sf sobject list --sobject ${type} --json`, { cwd });
                const result = JSON.parse(stdout);
                if (result.status === 0 && Array.isArray(result.result)) {
                    return result.result.sort();
                }
            } catch (cliError: any) {
                channel.appendLine(`CLI Fallback failed: ${cliError.message}`);
            }
            return [];
        }
    }

    public async describeSObject(sobject: string, useToolingApi: boolean = false): Promise<{ 
        fields: { name: string, label: string, type: string, relationshipName?: string, referenceTo?: string[], picklistValues?: any[] }[],
        childRelationships: { relationshipName: string, childSObject: string }[]
    }> {
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const apiPrefix = useToolingApi ? '/services/data/v' + auth.apiVersion + '/tooling' : '/services/data/v' + auth.apiVersion;
            const endpoint = `${apiPrefix}/sobjects/${sobject}/describe`;
            
            channel.appendLine(`Describing SObject via API: ${sobject} (Tooling: ${useToolingApi})`);
            const result = await this._request('GET', endpoint);
            
            if (result && Array.isArray(result.fields)) {
                const fields = result.fields.map((f: any) => ({
                    name: f.name,
                    label: f.label,
                    type: f.type,
                    relationshipName: f.relationshipName,
                    referenceTo: f.referenceTo,
                    picklistValues: f.picklistValues
                })).sort((a: any, b: any) => a.name.localeCompare(b.name));

                const childRelationships = Array.isArray(result.childRelationships) 
                    ? result.childRelationships
                        .filter((r: any) => r.relationshipName) 
                        .map((r: any) => ({
                            relationshipName: r.relationshipName,
                            childSObject: r.childSObject
                        })).sort((a: any, b: any) => a.relationshipName.localeCompare(b.relationshipName))
                    : [];

                return { fields, childRelationships };
            }
            return { fields: [], childRelationships: [] };
        } catch (error: any) {
            channel.appendLine(`API describeSObject failed for ${sobject}: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                let command = `sf sobject describe -s ${sobject} --json`;
                if (useToolingApi) {
                    command += ' -t';
                }
                const { stdout } = await exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 });
                const result = JSON.parse(stdout);
                
                if (result.status === 0 && result.result && Array.isArray(result.result.fields)) {
                    const fields = result.result.fields.map((f: any) => ({
                        name: f.name,
                        label: f.label,
                        type: f.type,
                        relationshipName: f.relationshipName,
                        referenceTo: f.referenceTo,
                        picklistValues: f.picklistValues
                    })).sort((a: any, b: any) => a.name.localeCompare(b.name));

                    const childRelationships = Array.isArray(result.result.childRelationships) 
                        ? result.result.childRelationships
                            .filter((r: any) => r.relationshipName) 
                            .map((r: any) => ({
                                relationshipName: r.relationshipName,
                                childSObject: r.childSObject
                            })).sort((a: any, b: any) => a.relationshipName.localeCompare(b.relationshipName))
                        : [];

                    return { fields, childRelationships };
                }
            } catch (cliError: any) {
                channel.appendLine(`CLI Fallback failed: ${cliError.message}`);
            }
            return { fields: [], childRelationships: [] };
        }
    }

    public async executeQuery(query: string, useToolingApi: boolean = false): Promise<{ totalSize: number, records: any[] }> {
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const apiPrefix = useToolingApi ? '/services/data/v' + auth.apiVersion + '/tooling' : '/services/data/v' + auth.apiVersion;
            // Need to URI encode the query
            const endpoint = `${apiPrefix}/query?q=${encodeURIComponent(query)}`;
            
            channel.appendLine(`Executing SOQL via API: ${query} (Tooling: ${useToolingApi})`);
            const result = await this._request('GET', endpoint);
            
            if (result && result.records) {
                return {
                    totalSize: result.totalSize,
                    records: result.records
                };
            }
            return { totalSize: 0, records: [] };
        } catch (error: any) {
            channel.appendLine(`API SOQL failed: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                let command = `sf data query -q "${query}" --json`;
                if (useToolingApi) {
                    command += ' -t';
                }
                const { stdout } = await exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 });
                const result = JSON.parse(stdout);
                
                if (result.status === 0 && result.result) {
                    return {
                        totalSize: result.result.totalSize,
                        records: result.result.records
                    };
                }
            } catch (cliError: any) {
                channel.appendLine(`CLI Fallback failed: ${cliError.message}`);
                throw cliError; // Rethrow to show in UI
            }
            return { totalSize: 0, records: [] };
        }
    }
    public async getApexLogs(): Promise<any[]> {
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const query = 'SELECT Id, LogUserId, LogUser.Name, Request, Operation, Application, Status, DurationMilliseconds, StartTime, Location, LogLength FROM ApexLog ORDER BY StartTime DESC LIMIT 100';
            const endpoint = `/services/data/v${auth.apiVersion}/tooling/query?q=${encodeURIComponent(query)}`;
            
            channel.appendLine('Fetching Apex Logs via API');
            const result = await this._request('GET', endpoint);
            
            if (result && Array.isArray(result.records)) {
                return result.records.map((r: any) => ({
                    Id: r.Id,
                    LogUser: { Name: r.LogUser?.Name },
                    Request: r.Request,
                    Operation: r.Operation,
                    Application: r.Application,
                    Status: r.Status,
                    DurationMilliseconds: r.DurationMilliseconds,
                    StartTime: r.StartTime,
                    Location: r.Location,
                    LogLength: r.LogLength
                }));
            }
            return [];
        } catch (error: any) {
            channel.appendLine(`API getApexLogs failed: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            try {
                const { stdout } = await exec('sf apex list log --json', { cwd });
                const result = JSON.parse(stdout);
                if (result.status === 0 && Array.isArray(result.result)) {
                    return result.result;
                }
            } catch (cliError: any) {
                channel.appendLine(`CLI Fallback failed: ${cliError.message}`);
            }
            return [];
        }
    }

    public async getApexLogContent(logId: string): Promise<string> {
        const channel = OutputChannel;
        try {
            const auth = await this._getAuth();
            const endpoint = `/services/data/v${auth.apiVersion}/tooling/sobjects/ApexLog/${logId}/Body`;
            
            channel.appendLine(`Fetching Apex Log body via API: ${logId}`);
            // Body endpoint returns the raw log content as a string if requested properly, 
            // but our _request parses JSON. Let's add a raw mode or handle it here.
            // Actually, the Body field in ApexLog SObject is reachable via REST.
            
            const auth2 = await this._getAuth();
            const url = new URL(`${auth2.instanceUrl}${endpoint}`);
            
            return new Promise((resolve, reject) => {
                const options = {
                    headers: { 'Authorization': `Bearer ${auth2.accessToken}` }
                };
                https.get(url, options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(data);
                        } else {
                            reject(new Error(`Failed to fetch log body: ${res.statusCode}`));
                        }
                    });
                }).on('error', reject);
            });
        } catch (error: any) {
            channel.appendLine(`API getApexLogContent failed: ${error.message}. Falling back to CLI.`);
            const cwd = this.getCwd();
            const path = require('path');
            const fs = require('fs');
            const os = require('os');
            const tempDir = path.join(os.tmpdir(), 'sfdevtools_logs');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

            try {
                const command = `sf apex get log --log-id ${logId} --output-dir "${tempDir}" --json`;
                await exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 });
                const filePath = path.join(tempDir, `${logId}.log`);
                if (fs.existsSync(filePath)) {
                    return fs.readFileSync(filePath, 'utf8');
                }
                throw new Error("Log file not found after download");
            } catch (cliError: any) {
                channel.appendLine(`CLI Fallback failed: ${cliError.message}`);
                throw cliError;
            }
        }
    }

    public async downloadApexLog(logId: string, outputDir: string): Promise<void> {
        const channel = OutputChannel;
        const path = require('path');
        const fs = require('fs');

        try {
            channel.appendLine(`Downloading log ${logId} to ${outputDir}...`);
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
