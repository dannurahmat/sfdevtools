"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Uri = exports.window = exports.workspace = void 0;
exports.workspace = {
    workspaceFolders: [
        {
            uri: {
                fsPath: '/mock/workspace'
            }
        }
    ]
};
exports.window = {
    showErrorMessage: () => { },
    showInformationMessage: () => { }
};
exports.Uri = {
    file: (path) => ({ fsPath: path }),
    parse: (url) => ({ fsPath: url })
};
//# sourceMappingURL=vscodeMock.js.map