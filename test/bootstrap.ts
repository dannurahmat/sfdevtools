const Module = require('module');
const originalLoader = Module._load;

export {};

declare global {
    var __sfdevtools_mock_exec: any;
}

// Global state for mocking exec
__sfdevtools_mock_exec = null;

Module._load = function (request: any, parent: any, isMain: any) {
    if (request === 'vscode') {
        const mockChannel = {
            appendLine: () => {},
            show: () => {},
            dispose: () => {}
        };
        return {
            workspace: {
                workspaceFolders: [
                    {
                        uri: {
                            fsPath: '/mock/workspace'
                        }
                    }
                ]
            },
            window: {
                showErrorMessage: () => {},
                showInformationMessage: () => {},
                createOutputChannel: () => mockChannel
            },
            Uri: {
                file: (path: string) => ({ fsPath: path }),
                parse: (url: string) => ({ fsPath: url })
            }
        };
    }
    
    const res = originalLoader.apply(this, arguments);
    
    if (request === 'child_process' || request === 'node:child_process') {
        return new Proxy(res, {
            get(target, prop) {
                if (prop === 'exec') {
                    return function(cmd: any, options: any, callback: any) {
                        const cb = typeof options === 'function' ? options : callback;
                        if (__sfdevtools_mock_exec) {
                            return __sfdevtools_mock_exec(cmd, options, cb);
                        }
                        return target.exec(cmd, options, cb);
                    };
                }
                return target[prop];
            }
        });
    }
    
    return res;
};
