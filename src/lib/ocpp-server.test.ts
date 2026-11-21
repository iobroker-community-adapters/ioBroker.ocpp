import { expect } from 'chai';
import WebSocket from 'ws';
import { OcppError, OcppServer } from './ocpp-server';
import { OCPP_MESSAGE_TYPE } from './ocpp-types';

describe('OcppServer (OCPP 1.6-J RPC & Connection Management)', () => {
    let server: OcppServer;
    let port: number;

    beforeEach(async () => {
        // Pick an ephemeral port using random range 45000-55000
        port = 45000 + Math.floor(Math.random() * 10000);
        server = new OcppServer({
            callTimeoutMs: 2000,
        });
        await server.listen(port, '127.0.0.1');
    });

    afterEach(async () => {
        await server.close();
    });

    it('accepts OCPP 1.6 connection, handles BootNotification CALL, and sends CALLRESULT', async () => {
        server.onRequest = async (client, action, payload) => {
            expect(client.url).to.equal('/EVB-P123456');
            expect(client.protocol).to.equal('ocpp1.6');
            expect(action).to.equal('BootNotification');
            expect(payload.chargePointVendor).to.equal('EVBox');
            return {
                status: 'Accepted',
                currentTime: '2026-11-07T17:00:00.000Z',
                interval: 55,
            };
        };

        const ws = new WebSocket(`ws://127.0.0.1:${port}/EVB-P123456`, ['ocpp1.6']);

        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        const responsePromise = new Promise<unknown[]>(resolve => {
            ws.once('message', data => {
                resolve(JSON.parse(data.toString()) as unknown[]);
            });
        });

        ws.send(
            JSON.stringify([
                OCPP_MESSAGE_TYPE.CALL,
                'msg-001',
                'BootNotification',
                { chargePointVendor: 'EVBox', chargePointModel: 'Elvi' },
            ]),
        );

        const frame = await responsePromise;
        expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALLRESULT);
        expect(frame[1]).to.equal('msg-001');
        expect(frame[2]).to.deep.equal({
            status: 'Accepted',
            currentTime: '2026-11-07T17:00:00.000Z',
            interval: 55,
        });

        ws.on('error', () => {
            // ignore ECONNRESET on close
        });
        ws.close();
    });

    it('sends server-to-client commands (e.g. SetChargingProfile) and strips undefined fields (#24)', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/Charger1`, ['ocpp1.6']);

        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        ws.on('message', data => {
            const frame = JSON.parse(data.toString()) as [number, string, string, Record<string, any>];
            expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALL);
            expect(frame[2]).to.equal('SetChargingProfile');
            // Verify undefined fields are stripped so strict charge points do not fail schema validation
            expect('numberPhases' in frame[3].csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0]).to.equal(
                false,
            );

            ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALLRESULT, frame[1], { status: 'Accepted' }]));
        });

        const client = server.getClient('/Charger1');
        expect(client).to.not.be.undefined;

        const res = await client!.sendCommand('SetChargingProfile', {
            connectorId: 1,
            csChargingProfiles: {
                chargingProfileId: 1,
                stackLevel: 0,
                chargingProfilePurpose: 'TxDefaultProfile',
                chargingProfileKind: 'Recurring',
                recurrencyKind: 'Daily',
                chargingSchedule: {
                    duration: 86400,
                    startSchedule: '2013-01-01T00:00:00.000Z',
                    chargingRateUnit: 'A',
                    chargingSchedulePeriod: [
                        {
                            startPeriod: 0,
                            limit: 16,
                            numberPhases: undefined,
                        },
                    ],
                },
            },
        });

        expect(res).to.deep.equal({ status: 'Accepted' });
        ws.on('error', () => {
            // ignore ECONNRESET on close
        });
        ws.close();
    });

    it('sends ClearChargingProfile command to clear charging profiles', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ChargerClear`, ['ocpp1.6']);
        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        ws.on('message', data => {
            const frame = JSON.parse(data.toString()) as [number, string, string, Record<string, unknown>];
            expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALL);
            expect(frame[2]).to.equal('ClearChargingProfile');
            expect(frame[3]).to.deep.equal({ connectorId: 1 });

            ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALLRESULT, frame[1], { status: 'Accepted' }]));
        });

        const client = server.getClient('/ChargerClear');
        expect(client).to.not.be.undefined;

        const res = await client!.sendCommand('ClearChargingProfile', { connectorId: 1 });
        expect(res).to.deep.equal({ status: 'Accepted' });

        ws.on('error', () => {
            // ignore ECONNRESET on close
        });
        ws.close();
    });

    it('replaces zombie connections when the same Charge Point reconnects (#20)', async () => {
        const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ABL-101`, ['ocpp1.6']);
        await new Promise<void>(resolve => ws1.once('open', () => resolve()));

        const firstClient = server.getClient('/ABL-101');
        expect(firstClient).to.not.be.undefined;

        // Reconnect with same URL before first socket is closed
        const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ABL-101`, ['ocpp1.6']);
        await new Promise<void>(resolve => ws2.once('open', () => resolve()));

        const secondClient = server.getClient('/ABL-101');
        expect(secondClient).to.not.be.undefined;
        expect(secondClient).to.not.equal(firstClient);
        expect(server.getClients().length).to.equal(1);

        // Ensure commands go to the second (active) connection
        ws2.once('message', data => {
            const frame = JSON.parse(data.toString()) as [number, string, string, Record<string, unknown>];
            ws2.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALLRESULT, frame[1], { status: 'Accepted' }]));
        });

        const res = await secondClient!.sendCommand('RemoteStartTransaction', { connectorId: 1, idTag: 'ioBroker' });
        expect(res).to.deep.equal({ status: 'Accepted' });

        ws1.on('error', () => {
            // ignore
        });
        ws2.on('error', () => {
            // ignore
        });
        ws1.close();
        ws2.close();
    });

    it('enforces Basic Authentication when configured', async () => {
        await server.close();
        server = new OcppServer({
            validateConnection: async (_url, creds) => {
                const valid = creds?.name === 'admin' && creds?.pass === 'secret';
                return [valid, valid ? 200 : 401, valid ? 'OK' : 'Unauthorized'];
            },
        });
        await server.listen(port, '127.0.0.1');

        // 1. Invalid credentials -> rejected
        const badWs = new WebSocket(`ws://wrong:pass@127.0.0.1:${port}/EVB`, ['ocpp1.6']);
        let failed = false;
        try {
            await new Promise<void>((resolve, reject) => {
                badWs.once('open', () => resolve());
                badWs.once('error', err => reject(err));
            });
        } catch {
            failed = true;
        }
        expect(failed).to.equal(true);

        // 2. Valid credentials -> accepted
        const goodWs = new WebSocket(`ws://admin:secret@127.0.0.1:${port}/EVB`, ['ocpp1.6']);
        await new Promise<void>((resolve, reject) => {
            goodWs.once('open', () => resolve());
            goodWs.once('error', err => reject(err));
        });
        expect(server.getClient('/EVB')).to.not.be.undefined;
        goodWs.on('error', () => {
            // ignore
        });
        goodWs.close();
    });

    it('returns OCPP CALLERROR frame when handler throws OcppError', async () => {
        server.onRequest = async (_client, action) => {
            throw new OcppError('NotImplemented', `Action ${action} not supported`);
        };

        const ws = new WebSocket(`ws://127.0.0.1:${port}/EVB`, ['ocpp1.6']);
        await new Promise<void>(resolve => ws.once('open', () => resolve()));

        const errorFramePromise = new Promise<unknown[]>(resolve => {
            ws.once('message', data => resolve(JSON.parse(data.toString()) as unknown[]));
        });

        ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALL, 'err-1', 'UnknownAction', {}]));

        const frame = await errorFramePromise;
        expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALLERROR);
        expect(frame[1]).to.equal('err-1');
        expect(frame[2]).to.equal('NotImplemented');
        ws.on('error', () => {
            // ignore ECONNRESET on close
        });
        ws.close();
    });

    it('serializes concurrent sendCommand calls so only 1 CALL is in-flight at a time (OCPP-J section 4.1)', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/QueueBox`, ['ocpp1.6']);
        await new Promise<void>(resolve => ws.once('open', () => resolve()));

        const receivedOrder: string[] = [];
        let inFlight = 0;
        let maxInFlight = 0;

        ws.on('message', data => {
            const frame = JSON.parse(data.toString()) as [number, string, string, Record<string, unknown>];
            inFlight++;
            if (inFlight > maxInFlight) {
                maxInFlight = inFlight;
            }
            receivedOrder.push(frame[2]);

            setTimeout(() => {
                inFlight--;
                ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALLRESULT, frame[1], { status: 'Accepted' }]));
            }, 25);
        });

        const client = server.getClient('/QueueBox')!;
        const [r1, r2, r3] = await Promise.all([
            client.sendCommand('SetChargingProfile', { connectorId: 1 }),
            client.sendCommand('ChangeAvailability', { connectorId: 1, type: 'Operative' }),
            client.sendCommand('Reset', { type: 'Soft' }),
        ]);

        expect(maxInFlight).to.equal(1);
        expect(receivedOrder).to.deep.equal(['SetChargingProfile', 'ChangeAvailability', 'Reset']);
        expect(r1).to.deep.equal({ status: 'Accepted' });
        expect(r2).to.deep.equal({ status: 'Accepted' });
        expect(r3).to.deep.equal({ status: 'Accepted' });

        ws.on('error', () => {
            // ignore
        });
        ws.close();
    });
});

// Test-only self-signed localhost certificate & key (CN=127.0.0.1, valid 100y)
const TEST_CERT = [
    '-----BEGIN CERTIFICATE-----',
    'MIICqjCCAZKgAwIBAgIIS1ohJrlKEJ4wDQYJKoZIhvcNAQELBQAwFDESMBAGA1UEAxMJMTI3LjAu',
    'MC4xMCAXDTI2MTEyMDIzMzA1NloYDzIxMjYxMTIxMjMzMDU2WjAUMRIwEAYDVQQDEwkxMjcuMC4w',
    'LjEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJTdPg1LtMPH7gNi7ZGZI/2rnew8fU',
    'SllTZAva8hVUMiJp81PbDvkqkAQJKmWBHPLWkBwsR7/2iSgIXCl9D5bKUjmfDby1/7gPQ3S2N4s2',
    '2WMYwvi3INORDi3wmufv1ju33/9rdHG33sNsPu74G5cbTVQPx86Gk5v7zgrtKdM0h6Z9iYFBPQfZ',
    'wj2FtlR3Z2UedbLjDPDTZkGK2GeIcwsNpUDR1X/fWBXuf2vXTWm/BZiZdZFV0cn+E9Ppmbrzk4Ym',
    '6+P0d6Mt6MJ9LIFwCIdXY4Uw2Y7H4fWWaFXiHuemThHuwYRh9YxaXe74s5YL6UdXBeNAiL9IpAs7',
    '3DLBRE2hAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAHOKM5LDka7+L9HSrc/16mZAnZADdxpWr23k',
    '07t9gYPxaC9mH7XEDGZKGp7yeeoN3EBnWjgFTJ0vOhiJ+RHptFis7f022ZJY6E+GhkL51wK50b+m',
    'pqzkj2DMOVPQUeD9TzTrfSpJolWQGNFVaQrW6FDMO2hxYFjETgJREcpf1GjOekpT6PiMFI0Ljf6D',
    'ZWxPB0evUCSjJ8CT650FVSupuc4mt/5P9yjRT8dRlFOpf0yKZp152MmARNNsPqbOyY2LsSBGOdWX',
    '36HWVfccwNu+49iQpqp2xqLPlq6KKSQn+D9c48xvC1GI7M3xrNW1EP4N1SJ6+r5KpSj2yksrILTz',
    'qUM=',
    '-----END CERTIFICATE-----',
].join('\n');

const TEST_KEY = [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDJTdPg1LtMPH7gNi7ZGZI/2rne',
    'w8fUSllTZAva8hVUMiJp81PbDvkqkAQJKmWBHPLWkBwsR7/2iSgIXCl9D5bKUjmfDby1/7gPQ3S2',
    'N4s22WMYwvi3INORDi3wmufv1ju33/9rdHG33sNsPu74G5cbTVQPx86Gk5v7zgrtKdM0h6Z9iYFB',
    'PQfZwj2FtlR3Z2UedbLjDPDTZkGK2GeIcwsNpUDR1X/fWBXuf2vXTWm/BZiZdZFV0cn+E9Ppmbrz',
    'k4Ym6+P0d6Mt6MJ9LIFwCIdXY4Uw2Y7H4fWWaFXiHuemThHuwYRh9YxaXe74s5YL6UdXBeNAiL9I',
    'pAs73DLBRE2hAgMBAAECggEABzWFT/juWDWWaZsnJFk5FpZTr7mdL2oWNtlPX2DqCKDfAKJZL3Ai',
    '1jZgHp/pEK2juLFigOd05XRV/a6nQbZMNSSqsZqBVpc41TsaM+hbUPSKCvn4hD5ltT0nwgUaJ0mp',
    'y9T2xbde1zHgF8FNN49tYunrB8GlEMa6gFMJqyKjUK82sXr75KtHzkZxfvfLjy6oQVqfbFzkW1jJ',
    'kyiboXDtRCj10T5g3I0kDXdEUc5Q/MgL193QctsK4IRB/u5kqwCaH5sB7RJk0qgFvdWiQUl8cK3c',
    'AvJD0YTBUQoxk1gBNs6ueDpcu8IEPfnS6IDw+dWM/kR036KeMlRWBxvQNvgGLQKBgQDlazoPfggE',
    'm4RB4/KzyU+bTy5WQiN+owo9sR8/Pq5ti7+3ALyFVBPTYwgd4bIbjBHmaBXiOVSncAU6J/rAuxlu',
    'lnJu3HmBOKCEivI5cp+bawLMXnPwrKNupVd1oux1qC2bHyBOM8jZvyfkSHPDpA24yqj0CFK5MztQ',
    'pIZtwJ65JwKBgQDgoLBfJgKtVxWKec+RhWJZIjB68/4zccn4uw2az963WUu+lkjZ8ClAn9QKwtE2',
    'FSuxVGyhL4X/ztVHtgQ+PZLykK2lg7ltNvZkWznxuEjGKkzLfrS5Eli5I4MesD61v78/aR3/hT56',
    'GyY9C6vBFlIkAF7F+qONx3ida2UdKMKv9wKBgEJyykBOergK60XCZjuYpUwQpRUq1ukJBCBWOvyw',
    'hQkJnx+8QN5FOfDSEDnHczTzXwPjReNeQ5yzn2/2wHQuPPGA9egSR8cbxbJeJEZrYrs7RXY4LVCa',
    'UEPt8+UIqYByk7MIUu0Tpqsa6M0ABze1Ppw1ZrY36u3lXtq+rIkBb3elAoGBAL1HqlcC+I6IKyac',
    'rkO5Wb4yCRgSMcm3wLFPLY+eSdXF8QWQLaM3tAs4orzOnOwturuaoE7SdN+xshbTUZAA4qpzL1+h',
    'N8bH4ad/F7yPxQL28e8nvbGVvB2Fxx889BrCkK0mLpj59kN+TSJziy8RV/XuOe4p3VfDFefQb0u6',
    '5RLRAoGAMFXc1vRa73ac0Gm+J0tlpP2wXz2o1fhTH8TAJTSyBHFj8BMg0hYWOo8Xx/ShyQ/PWEpl',
    'A+5ZZF3EE5xFjifTM+3Qneme7JPV4o8+rObO0GPkoU4LNZ/6Jb5SeC72ww6azliYbGBXAXW8rI8Y',
    'M5PssSJaP5+lXqhNaGdmMX6+KQo=',
    '-----END PRIVATE KEY-----',
].join('\n');

describe('OcppServer TLS (wss://)', () => {
    let tlsServer: OcppServer;
    let tlsPort: number;

    beforeEach(async () => {
        tlsPort = 45000 + Math.floor(Math.random() * 10000);
        tlsServer = new OcppServer({
            callTimeoutMs: 2000,
            tlsOptions: {
                cert: TEST_CERT,
                key: TEST_KEY,
            },
        });
        await tlsServer.listen(tlsPort, '127.0.0.1');
    });

    afterEach(async () => {
        await tlsServer.close();
    });

    it('accepts wss:// connections and handles BootNotification CALL', async () => {
        tlsServer.onRequest = async (_client, action) => {
            expect(action).to.equal('BootNotification');
            return { status: 'Accepted', currentTime: '2026-11-22T00:00:00.000Z', interval: 60 };
        };

        const ws = new WebSocket(`wss://127.0.0.1:${tlsPort}/EVB-TLS`, ['ocpp1.6'], {
            rejectUnauthorized: false,
        });

        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        const responsePromise = new Promise<unknown[]>(resolve => {
            ws.once('message', data => resolve(JSON.parse(data.toString()) as unknown[]));
        });

        ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALL, 'tls-1', 'BootNotification', { chargePointVendor: 'EVBox' }]));

        const frame = await responsePromise;
        expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALLRESULT);
        expect(frame[1]).to.equal('tls-1');
        expect((frame[2] as { status: string }).status).to.equal('Accepted');

        ws.on('error', () => {
            // ignore
        });
        ws.close();
    });

    it('invokes onTlsError when a plain ws:// client connects to a wss:// server', async () => {
        const tlsErrorPromise = new Promise<Error>(resolve => {
            tlsServer.onTlsError = err => resolve(err);
        });

        const ws = new WebSocket(`ws://127.0.0.1:${tlsPort}/EVB-PLAIN`, ['ocpp1.6']);
        ws.on('error', () => {
            // expected handshake failure
        });

        const err = await tlsErrorPromise;
        expect(err).to.be.an('error');
    });
});
