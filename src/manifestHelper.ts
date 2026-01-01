import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class ManifestHelper {
    
    private getManifestPath(fileName: string, createDir: boolean = false): string | undefined {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const manifestDir = path.join(root, 'manifest');
            if (createDir && !fs.existsSync(manifestDir)) {
                fs.mkdirSync(manifestDir);
            }
            return path.join(manifestDir, fileName);
        }
        return undefined;
    }

    public async updateManifest(fileName: string, items: { type: string, fullName: string }[], apiVersion: string = '62.0', fullPath?: string): Promise<string> {
        const filePath = fullPath || this.getManifestPath(fileName, true);
        if (!filePath) {
            throw new Error("No workspace folder open and no path provided.");
        }

        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        let content = '';
        if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, 'utf8');
        } else {
            content = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <version>${apiVersion}</version>
</Package>`;
        }

        const newContent = this.mergeItems(content, items);
        fs.writeFileSync(filePath, newContent);
        return filePath;
    }

    public async clearManifest(fileName: string, apiVersion: string = '62.0', fullPath?: string): Promise<string> {
        const filePath = fullPath || this.getManifestPath(fileName, true);
        if (!filePath) {
            throw new Error("No workspace folder open and no path provided.");
        }

        const content = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <version>${apiVersion}</version>
</Package>`;
        fs.writeFileSync(filePath, content);
        return filePath;
    }

    public async deleteManifests(paths: string[]): Promise<void> {
        for (const p of paths) {
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
            }
        }
    }

    private mergeItems(xmlContent: string, items: { type: string, fullName: string }[]): string {
        // Simple regex based parsing to avoid heavy deps
        // Group items by type
        const itemsByType: { [key: string]: Set<string> } = {};
        items.forEach(item => {
            if (!itemsByType[item.type]) {
                itemsByType[item.type] = new Set();
            }
            itemsByType[item.type].add(item.fullName);
        });

        // 1. Parse existing
        const typeRegex = /<types>([\s\S]*?)<\/types>/g;
        let match;
        
        // Improve existing map with what's in the XML
        while ((match = typeRegex.exec(xmlContent)) !== null) {
            const typeBlock = match[1];
            const nameMatch = /<name>(.*?)<\/name>/.exec(typeBlock);
            if (nameMatch) {
                const typeName = nameMatch[1];
                if (!itemsByType[typeName]) {
                    itemsByType[typeName] = new Set();
                }
                
                const memberRegex = /<members>(.*?)<\/members>/g;
                let memberMatch;
                while ((memberMatch = memberRegex.exec(typeBlock)) !== null) {
                    itemsByType[typeName].add(memberMatch[1]);
                }
            }
        }

        // 2. Reconstruct XML
        // We will strip all <types> blocks and rebuild them, preserving the header/footer
        let newXml = xmlContent.replace(/<types>[\s\S]*?<\/types>\s*/g, '');
        
        // Remove closing tag to append before it
        newXml = newXml.replace('</Package>', '').trim();

        // Sort types
        const sortedTypes = Object.keys(itemsByType).sort();

        let typesString = '';
        sortedTypes.forEach(type => {
            typesString += '\n    <types>\n';
            const members = Array.from(itemsByType[type]).sort();
            members.forEach(member => {
                typesString += `        <members>${member}</members>\n`;
            });
            typesString += `        <name>${type}</name>\n    </types>`;
        });

        return `${newXml}${typesString}\n</Package>`;
    }

    public readManifest(fileName: string, fullPath?: string): { type: string, fullName: string }[] {
        const filePath = fullPath || this.getManifestPath(fileName);
        if (!filePath || !fs.existsSync(filePath)) {
            return [];
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const items: { type: string, fullName: string }[] = [];

        // Simple regex based parsing
        const typeRegex = /<types>([\s\S]*?)<\/types>/g;
        let match;
        
        while ((match = typeRegex.exec(content)) !== null) {
            const typeBlock = match[1];
            const nameMatch = /<name>(.*?)<\/name>/.exec(typeBlock);
            if (nameMatch) {
                const typeName = nameMatch[1];
                const memberRegex = /<members>(.*?)<\/members>/g;
                let memberMatch;
                while ((memberMatch = memberRegex.exec(typeBlock)) !== null) {
                    items.push({ type: typeName, fullName: memberMatch[1] });
                }
            }
        }
        return items;
    }
}
