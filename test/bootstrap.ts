const Module = require('module');
const originalLoader = Module._load;

// Global state for mocking exec
global.__sfdevtools_mock_exec = null;

Module._load = function (request, parent, isMain) {
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
                    return function(cmd, options, callback) {
                        const cb = typeof options === 'function' ? options : callback;
                        if (global.__sfdevtools_mock_exec) {
                            return global.__sfdevtools_mock_exec(cmd, options, cb);
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
