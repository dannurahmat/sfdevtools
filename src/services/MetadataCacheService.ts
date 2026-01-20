import { SfCli } from '../sfCli';
import { OutputChannel } from '../utils/outputChannel';

export class MetadataCacheService {
    private static _instance: MetadataCacheService;
    private _sfCli: SfCli;
    private _typesCache: string[] | undefined;
    private _componentCache: Map<string, { fullName: string, id: string }[]> = new Map();
    private _isInitializing: boolean = false;
    
    // Types to pre-fetch in background
    private readonly PREFETCH_TYPES = [
        'CustomField', 
        'ApexClass',
        'ApexTrigger', 
        'LightningComponentBundle', 
        'ApexPage',
        'Flow'
    ];

    private constructor() {
        this._sfCli = new SfCli();
    }

    public static getInstance(): MetadataCacheService {
        if (!MetadataCacheService._instance) {
            MetadataCacheService._instance = new MetadataCacheService();
        }
        return MetadataCacheService._instance;
    }

    public async initialize(): Promise<void> {
        if (this._isInitializing) return;
        this._isInitializing = true;
        
        try {
            OutputChannel.appendLine('MetadataCacheService: Starting background cache initialization...');
            
            // 1. Fetch Metadata Types
            this._typesCache = await this._sfCli.describeMetadata();
            OutputChannel.appendLine(`MetadataCacheService: Cached ${this._typesCache.length} metadata types.`);

            // 2. Fetch specific components
            for (const type of this.PREFETCH_TYPES) {
                try {
                    const components = await this._sfCli.listMetadata(type);
                    this._componentCache.set(type, components);
                    OutputChannel.appendLine(`MetadataCacheService: Cached ${components.length} components for ${type}.`);
                } catch (e: any) {
                    OutputChannel.appendLine(`MetadataCacheService: Failed to cache ${type}: ${e.message}`);
                }
            }
            
            OutputChannel.appendLine('MetadataCacheService: Background cache initialization complete.');
        } catch (error: any) {
            OutputChannel.appendLine(`MetadataCacheService: Initialization failed: ${error.message}`);
        } finally {
            this._isInitializing = false;
        }
    }

    public async getMetadataTypes(): Promise<string[]> {
        if (this._typesCache) {
            return this._typesCache;
        }
        // If not cached, fetch it
        this._typesCache = await this._sfCli.describeMetadata();
        return this._typesCache;
    }

    public async getComponents(type: string): Promise<{ fullName: string, id: string }[]> {
        if (this._componentCache.has(type)) {
            return this._componentCache.get(type)!;
        }
        // If not cached, fetch it
        const components = await this._sfCli.listMetadata(type);
        // Cache it for future use during this session
        this._componentCache.set(type, components);
        return components;
    }

    public refreshCache(): void {
        this._typesCache = undefined;
        this._componentCache.clear();
        this.initialize();
    }
}
