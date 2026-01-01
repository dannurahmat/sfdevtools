import * as vscode from 'vscode';

export class OutputChannel {
    private static _channel: vscode.OutputChannel;

    public static getChannel(): vscode.OutputChannel {
        if (!this._channel) {
            this._channel = vscode.window.createOutputChannel('SF DevTools');
        }
        return this._channel;
    }

    public static appendLine(message: string) {
        this.getChannel().appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    public static show() {
        this.getChannel().show();
    }
}
