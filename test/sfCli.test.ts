import { expect } from 'chai';
import * as sinon from 'sinon';
import { SfCli } from '../src/sfCli';

describe('SfCli', () => {
    let sfCli: SfCli;
    let mockExec: sinon.SinonStub;

    beforeEach(() => {
        sfCli = new SfCli();
        mockExec = sinon.stub();
        (global as any).__sfdevtools_mock_exec = mockExec;
    });

    afterEach(() => {
        (global as any).__sfdevtools_mock_exec = null;
        sinon.restore();
    });

    describe('getOrgList', () => {
        it('should return a list of orgs when the command succeeds', async () => {
            const mockOutput = {
                status: 0,
                result: {
                    nonScratchOrgs: [
                        { alias: 'prod', username: 'prod@example.com', status: 'Active' }
                    ],
                    scratchOrgs: [
                        { alias: 'dev', username: 'dev@example.com', status: 'Active' }
                    ]
                }
            };

            mockExec.callsFake((cmd, opts, cb) => {
                cb(null, { stdout: JSON.stringify(mockOutput), stderr: '' });
                return {};
            });

            const orgs = await sfCli.getOrgList();

            expect(orgs).to.have.lengthOf(2);
            expect(orgs[0].alias).to.equal('prod');
            expect(orgs[1].alias).to.equal('dev');
        });

        it('should return an empty list when the command fails', async () => {
            mockExec.callsFake((cmd, opts, cb) => {
                cb(new Error('Command failed'), { stdout: '', stderr: '' });
                return {};
            });

            const orgs = await sfCli.getOrgList();
            expect(orgs).to.be.empty;
        });
    });

    describe('describeMetadata', () => {
        it('should return unique metadata types', async () => {
            const mockOutput = {
                status: 0,
                result: {
                    metadataObjects: [
                        { xmlName: 'ApexClass', childXmlNames: [] },
                        { xmlName: 'CustomObject', childXmlNames: ['CustomField'] }
                    ]
                }
            };

            mockExec.callsFake((cmd, opts, cb) => {
                cb(null, { stdout: JSON.stringify(mockOutput), stderr: '' });
                return {};
            });

            const types = await sfCli.describeMetadata(true);

            expect(types).to.include('ApexClass');
            expect(types).to.include('CustomObject');
            expect(types).to.include('CustomField');
            expect(types).to.have.lengthOf(3);
        });
    });

    describe('executeQuery', () => {
        it('should return records when query succeeds', async () => {
            const mockOutput = {
                status: 0,
                result: {
                    totalSize: 1,
                    records: [{ Name: 'Test Account' }]
                }
            };

            mockExec.callsFake((cmd, opts, cb) => {
                cb(null, { stdout: JSON.stringify(mockOutput), stderr: '' });
                return {};
            });

            const result = await sfCli.executeQuery('SELECT Name FROM Account');

            expect(result.totalSize).to.equal(1);
            expect(result.records).to.have.lengthOf(1);
            expect(result.records[0].Name).to.equal('Test Account');
        });

        it('should throw an error when query fails', async () => {
            const mockErrorOutput = {
                message: 'Malformed Query'
            };

            mockExec.callsFake((cmd, opts, cb) => {
                const err: any = new Error('Command failed');
                err.stdout = JSON.stringify(mockErrorOutput);
                cb(err, { stdout: JSON.stringify(mockErrorOutput), stderr: '' });
                return {};
            });

            try {
                await sfCli.executeQuery('INVALID QUERY');
                expect.fail('Should have thrown an error');
            } catch (error: any) {
                expect(error.message).to.equal('Malformed Query');
            }
        });
    });
});
