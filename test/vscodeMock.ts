export const workspace = {
    workspaceFolders: [
        {
            uri: {
                fsPath: '/mock/workspace'
            }
        }
    ]
};

export const window = {
    showErrorMessage: () => {},
    showInformationMessage: () => {}
};

export const Uri = {
    file: (path: string) => ({ fsPath: path }),
    parse: (url: string) => ({ fsPath: url })
};
