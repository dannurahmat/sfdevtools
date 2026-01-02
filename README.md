# SF DevTools

Salesforce Developer Tools for VS Code. A powerful extension designed to streamline Salesforce development workflows directly within your IDE.

## Features

### 🚀 Metadata Browser
- Browse and search all available metadata types in your Salesforce Org.
- Easily select and manage components.

### 🔍 SOQL & Tooling Query Builder
- Build and execute SOQL queries with ease.
- Support for **Tooling API Queries** to inspect system metadata and settings.

### 📜 Apex Log Viewer
- Real-time access to Apex debug logs.
- Download and analyze logs to debug your code faster.

### 🌐 GraphQL Explorer
- Explore and test Salesforce GraphQL queries.
- Interactive interface for data exploration.

### 🔌 Org Management
- Quick connection to various Salesforce Orgs.
- Seamless switching between authenticated environments.

## Installation

1. Install the **SF DevTools** extension from the VS Code Marketplace.
2. Ensure you have the **Salesforce CLI** installed and authenticated.

## Usage

Access SF DevTools from the **Activity Bar** (Tools icon). You will find two main views:
- **Tools**: Access the Metadata Browser, SOQL Builder, Apex Logs, etc.
- **Org Connection**: Manage your connections and refresh Org data.

### Commands

Available via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):
- `SF DevTools: Connect to Org`
- `SF DevTools: Refresh Org`
- `Open Metadata Browser`
- `SOQL Builder`
- `Tooling API Query`
- `GraphQL Explorer`
- `Open Apex Logs`

## Requirements

- VS Code version 1.90.0 or higher.
- Salesforce CLI (sfdx/sf).

## Extension Settings

Currently, this extension uses your default Salesforce CLI configuration.

