import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import { ManifestHelper } from '../src/manifestHelper';

describe('ManifestHelper', () => {
    let manifestHelper: ManifestHelper;
    let fsWriteFileSyncStub: sinon.SinonStub;
    let fsExistsSyncStub: sinon.SinonStub;
    let fsReadFileSyncStub: sinon.SinonStub;
    let fsMkdirSyncStub: sinon.SinonStub;

    beforeEach(() => {
        manifestHelper = new ManifestHelper();
        fsWriteFileSyncStub = sinon.stub(fs, 'writeFileSync');
        fsExistsSyncStub = sinon.stub(fs, 'existsSync');
        fsReadFileSyncStub = sinon.stub(fs, 'readFileSync');
        fsMkdirSyncStub = sinon.stub(fs, 'mkdirSync');
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('updateManifest', () => {
        it('should create a new manifest file if it does not exist', async () => {
            const fileName = 'package.xml';
            const items = [{ type: 'ApexClass', fullName: 'MyClass' }];
            const fullPath = '/tmp/package.xml';

            fsExistsSyncStub.withArgs(path.dirname(fullPath)).returns(true);
            fsExistsSyncStub.withArgs(fullPath).returns(false);

            await manifestHelper.updateManifest(fileName, items, '62.0', fullPath);

            expect(fsWriteFileSyncStub.calledOnce).to.be.true;
            const writtenContent = fsWriteFileSyncStub.firstCall.args[1];
            expect(writtenContent).to.contain('<version>62.0</version>');
            expect(writtenContent).to.contain('<members>MyClass</members>');
            expect(writtenContent).to.contain('<name>ApexClass</name>');
        });

        it('should merge items into an existing manifest file', async () => {
            const fileName = 'package.xml';
            const items = [{ type: 'ApexClass', fullName: 'NewClass' }];
            const fullPath = '/tmp/package.xml';
            const existingContent = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>ExistingClass</members>
        <name>ApexClass</name>
    </types>
    <version>62.0</version>
</Package>`;

            fsExistsSyncStub.withArgs(path.dirname(fullPath)).returns(true);
            fsExistsSyncStub.withArgs(fullPath).returns(true);
            fsReadFileSyncStub.withArgs(fullPath, 'utf8').returns(existingContent);

            await manifestHelper.updateManifest(fileName, items, '62.0', fullPath);

            expect(fsWriteFileSyncStub.calledOnce).to.be.true;
            const writtenContent = fsWriteFileSyncStub.firstCall.args[1];
            expect(writtenContent).to.contain('<members>ExistingClass</members>');
            expect(writtenContent).to.contain('<members>NewClass</members>');
            expect(writtenContent).to.contain('<name>ApexClass</name>');
        });
    });

    describe('readManifest', () => {
        it('should return empty list if manifest file does not exist', () => {
            const fileName = 'package.xml';
            const fullPath = '/tmp/package.xml';

            fsExistsSyncStub.withArgs(fullPath).returns(false);

            const result = manifestHelper.readManifest(fileName, fullPath);
            expect(result).to.be.empty;
        });

        it('should parse items from an existing manifest file', () => {
            const fileName = 'package.xml';
            const fullPath = '/tmp/package.xml';
            const content = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>Class1</members>
        <members>Class2</members>
        <name>ApexClass</name>
    </types>
    <version>62.0</version>
</Package>`;

            fsExistsSyncStub.withArgs(fullPath).returns(true);
            fsReadFileSyncStub.withArgs(fullPath, 'utf8').returns(content);

            const result = manifestHelper.readManifest(fileName, fullPath);
            expect(result).to.have.lengthOf(2);
            expect(result).to.deep.include({ type: 'ApexClass', fullName: 'Class1' });
            expect(result).to.deep.include({ type: 'ApexClass', fullName: 'Class2' });
        });
    });
});
