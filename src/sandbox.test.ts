/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */
import { Duplex, EventEmitter, Readable } from 'node:stream';

import Docker from 'dockerode';
import * as tar from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';

import { nanoid } from './nanoid';
import { Sandbox } from './sandbox';
import { SandboxMetaData } from './types';

const mockDocker = mockDeep<Docker>();
const mockContainer = mockDeep<Docker.Container>();
const mockExec = mockDeep<Docker.Exec>();
const mockImage = mockDeep<Docker.Image>();

vi.mock('dockerode', () => ({
  default: vi.fn(function () {
    return mockDocker;
  }),
}));

vi.mock('./nanoid');

vi.mock('tar-stream');
const mockPack = mockDeep<tar.Pack>();

const mockTimestamp = 1700000000000;

describe('Unit Tests', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(mockTimestamp));
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });
  describe('Sandbox', () => {
    describe('Sandbox.list', () => {
      const mockContainerInfoList: Docker.ContainerInfo[] = Array.from(
        { length: 10 },
        (_, index) => ({
          Id: `container${index}`,
          Names: [`/sbx_${index}`],
          Image: 'mock-vercel-sandbox:latest',
          ImageID: `sha256:abc123`,
          Command: '/bin/bash',
          Created: 9 - index + 1,
          Ports: [],
          Labels: {
            'mock-vercel-sandbox': 'true',
            sandboxId: `sbx_${index}`,
            runtime: 'node22',
          },
          State: 'running',
          Status: 'Up',
          HostConfig: { NetworkMode: 'default' },
          NetworkSettings: { Networks: {} },
          Mounts: [],
        }),
      );

      beforeEach(() => {
        mockDocker.listContainers.mockResolvedValue(mockContainerInfoList);

        mockDocker.getContainer.mockReturnValue(mockContainer);

        mockTarExtract({
          '.timeout_timestamp': '1699300000',
        });
        mockContainer.getArchive.mockResolvedValue(new Readable());
      });

      it('should list sandboxes', async () => {
        const result = await Sandbox.list({});

        expect(mockDocker.listContainers).toHaveBeenCalledWith({
          all: true,
          filters: { label: ['mock-vercel-sandbox=true'] },
          abortSignal: undefined,
        });

        expect(result.sandboxes).toHaveLength(10);
        expect(result.sandboxes[0].id).toBe('sbx_0');
        expect(result.sandboxes[0].status).toBe('running');
        expect(result.sandboxes[0].runtime).toBe('node22');
        expect(result.pagination.count).toBe(10);
        expect(result.pagination.total).toBe(10);
        expect(result.pagination.prev).toBe(10000);
        expect(result.pagination.next).toBe(1000);
      });

      it('should list sandboxes with limit', async () => {
        const result = await Sandbox.list({ limit: 5 });
        expect(result.sandboxes).toHaveLength(5);
        expect(result.pagination.count).toBe(5);
        expect(result.pagination.total).toBe(10);
        expect(result.sandboxes[0].id).toBe(
          mockContainerInfoList[0].Labels.sandboxId,
        );
        expect(result.pagination.prev).toBe(10000);
        expect(result.pagination.next).toBe(6000);
      });

      it('should list sandboxes with until parameter', async () => {
        let result = await Sandbox.list({ until: 6500 });
        expect(result.sandboxes).toHaveLength(6);
        expect(result.sandboxes).toSatisfyAll(
          (sandbox: SandboxMetaData) => sandbox.createdAt < 6500,
        );
        expect(result.pagination.count).toBe(6);
        expect(result.pagination.total).toBe(10);
        expect(result.pagination.prev).toBe(6000);
        expect(result.pagination.next).toBe(1000);

        result = await Sandbox.list({ until: 6000 });
        expect(result.sandboxes[0].createdAt).toBe(5000);
      });

      it('should list sandboxes with since parameter', async () => {
        let result = await Sandbox.list({ since: 6500 });
        expect(result.sandboxes).toHaveLength(4);
        expect(result.sandboxes).toSatisfyAll(
          (sandbox: SandboxMetaData) => sandbox.createdAt >= 6500,
        );
        expect(result.pagination.count).toBe(4);
        expect(result.pagination.total).toBe(10);
        expect(result.pagination.prev).toBe(10000);
        expect(result.pagination.next).toBe(7000);

        result = await Sandbox.list({ since: 6000 });
        expect(result.sandboxes[result.sandboxes.length - 1].createdAt).toBe(
          7000,
        );
      });

      it('should list sandboxes with since and until parameter', async () => {
        const result = await Sandbox.list({ since: 1500, until: 2500 });
        expect(result.sandboxes).toHaveLength(1);
        expect(result.sandboxes).toSatisfyAll(
          (sandbox: SandboxMetaData) =>
            sandbox.createdAt >= 1500 && sandbox.createdAt < 2500,
        );
        expect(result.pagination.count).toBe(1);
        expect(result.pagination.total).toBe(10);
        expect(result.pagination.next).toBe(2000);
        expect(result.pagination.prev).toBe(2000);
      });

      it('should handle empty list cases', async () => {
        let result = await Sandbox.list({ limit: 0 });
        expect(result.sandboxes).toHaveLength(0);
        expect(result.pagination.count).toBe(0);
        expect(result.pagination.total).toBe(10);
        expect(result.pagination.prev).toBeNull();
        expect(result.pagination.next).toBeNull();

        result = await Sandbox.list({ since: 10000 });
        expect(result.sandboxes).toHaveLength(0);
        expect(result.pagination.count).toBe(0);
        expect(result.pagination.total).toBe(10);
        expect(result.pagination.prev).toBeNull();
        expect(result.pagination.next).toBeNull();

        result = await Sandbox.list({ until: 1000 });
        expect(result.sandboxes).toHaveLength(0);
        expect(result.pagination.count).toBe(0);
        expect(result.pagination.total).toBe(10);
        expect(result.pagination.prev).toBeNull();
        expect(result.pagination.next).toBeNull();
      });

      it('should handle since and until parameters as Date', async () => {
        const sinceDate = new Date(1000);
        let result = await Sandbox.list({ since: sinceDate });
        expect(result.sandboxes[result.sandboxes.length - 1].createdAt).toBe(
          2000,
        );

        const untilDate = new Date(2000);
        result = await Sandbox.list({ until: untilDate });
        expect(result.sandboxes[0].createdAt).toBe(1000);
      });
    });

    describe('Sandbox.create', () => {
      const mockId = 'test1234567890123456789012';

      beforeEach(() => {
        mockDocker.getImage.mockReturnValue(mockImage);
        mockImage.inspect.mockResolvedValue({} as Docker.ImageInspectInfo);
        mockDocker.createContainer.mockResolvedValue(mockContainer);
        mockDocker.getContainer.mockReturnValue(mockContainer);
        mockContainer.start.mockResolvedValue(undefined);
        mockDocker.modem.followProgress.mockImplementation(
          (
            _stream: unknown,
            onFinished: (err: Error | null, _result: unknown[]) => void,
          ) => {
            onFinished(null, []);
          },
        );

        vi.mocked(nanoid).mockReturnValue(mockId);

        vi.mocked(tar.pack).mockReturnValue(mockPack);
      });

      it('should create a sandbox with default parameters', async () => {
        const sandbox = await Sandbox.create();

        expect(mockDocker.getImage).toHaveBeenCalledWith(
          'mock-vercel-sandbox:latest',
        );
        expect(mockDocker.createContainer).toHaveBeenCalledWith({
          Image: 'mock-vercel-sandbox:latest',
          name: `sbx_${mockId}`,
          ExposedPorts: {},
          HostConfig: {
            PortBindings: {},
            AutoRemove: true,
          },
          Labels: {
            'mock-vercel-sandbox': 'true',
            sandboxId: `sbx_${mockId}`,
            runtime: 'node22',
          },
          abortSignal: undefined,
        });
        expect(mockContainer.start).toHaveBeenCalledOnce();
        expect(sandbox.sandboxId).toBe(`sbx_${mockId}`);
        expect(sandbox.status).toBe('running');
        expect(sandbox.timeout).toBe(300000);
        expect(sandbox.routes).toHaveLength(0);
        expect(mockPack.entry).toHaveBeenCalledExactlyOnceWith(
          {
            name: '.timeout_timestamp',
          },
          Buffer.from(String(Math.floor((mockTimestamp + 300000) / 1000))),
        );
      });

      it('should create a sandbox with custom timeout', async () => {
        const sandbox = await Sandbox.create({ timeout: 600000 });

        expect(sandbox.timeout).toBe(600000);
        expect(mockPack.entry).toHaveBeenCalledExactlyOnceWith(
          {
            name: '.timeout_timestamp',
          },
          Buffer.from(String(Math.floor((mockTimestamp + 600000) / 1000))),
        );
      });

      it('should create a sandbox with custom runtime', async () => {
        await Sandbox.create({ runtime: 'python3' });

        expect(mockDocker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            Labels: expect.objectContaining({
              runtime: 'python3',
            }),
          }),
        );
      });

      it('should create a sandbox with ports', async () => {
        const sandbox = await Sandbox.create({ ports: [3000, 8080] });

        expect(mockDocker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            ExposedPorts: {
              '3000/tcp': {},
              '8080/tcp': {},
            },

            HostConfig: expect.objectContaining({
              PortBindings: {
                '3000/tcp': [{ HostPort: '3000' }],
                '8080/tcp': [{ HostPort: '8080' }],
              },
            }),
          }),
        );
        expect(sandbox.routes).toHaveLength(2);
        expect(sandbox.routes[0].port).toBe(3000);
        expect(sandbox.routes[0].url).toBe('http://localhost:3000');
        expect(sandbox.routes[1].port).toBe(8080);
        expect(sandbox.routes[1].url).toBe('http://localhost:8080');
      });

      it('should build image if it does not exist', async () => {
        const buildStream = new Readable({
          read() {
            // Empty implementation
          },
        });
        const error = new Error('no such image');
        (error as Error & { reason: string }).reason = 'no such image';
        mockImage.inspect.mockRejectedValueOnce(error);
        mockDocker.buildImage.mockResolvedValue(buildStream);

        await Sandbox.create();

        expect(mockDocker.buildImage).toHaveBeenCalled();
        expect(mockDocker.modem.followProgress).toHaveBeenCalled();
      });

      it('should build image if rebuild is true', async () => {
        const buildStream = new Readable({
          read() {
            // Empty implementation
          },
        });
        mockDocker.buildImage.mockResolvedValue(buildStream);

        await Sandbox.create({ rebuild: true });

        expect(mockDocker.buildImage).toHaveBeenCalled();
        expect(mockDocker.modem.followProgress).toHaveBeenCalled();
      });

      it('should not build image if it exists and rebuild is false', async () => {
        await Sandbox.create({ rebuild: false });

        expect(mockDocker.buildImage).not.toHaveBeenCalledOnce();
      });

      it('should handle source with git clone', async () => {
        const mockStream = new Duplex({
          read() {
            // Empty implementation
          },
        });
        mockContainer.exec.mockResolvedValue(mockExec);
        mockExec.start.mockResolvedValue(mockStream);

        await Sandbox.create({
          source: {
            type: 'git',
            url: 'https://github.com/user/repo.git',
          },
        });

        expect(mockContainer.exec).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            Cmd: [
              'git',
              'clone',
              'https://github.com/user/repo.git',
              '/vercel/sandbox',
            ],
          }),
        );
        expect(mockExec.start).toHaveBeenCalledOnce();
      });

      it('should handle source with tarball', async () => {
        const mockResponse = {
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
        } as unknown as Response;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

        await Sandbox.create({
          source: {
            type: 'tarball',
            url: 'https://example.com/archive.tar.gz',
          },
        });

        expect(global.fetch).toHaveBeenCalledWith(
          'https://example.com/archive.tar.gz',
          { signal: undefined },
        );

        expect(mockContainer.putArchive).toHaveBeenCalledWith(
          expect.any(Buffer),
          {
            path: '/vercel/sandbox',
            abortSignal: undefined,
          },
        );
      });

      it('should pass abort signal to Docker operations', async () => {
        const signal = new AbortController().signal;

        await Sandbox.create({ signal });

        expect(mockDocker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            abortSignal: signal,
          }),
        );
        expect(mockContainer.start).toHaveBeenCalledWith({
          abortSignal: signal,
        });
      });
    });

    describe('Sandbox.get', () => {
      const mockSandboxId = 'sbx_test123';
      const mockContainerId = 'container123';
      const mockCreatedTimestamp = 1000;

      const mockContainerInfo: Docker.ContainerInfo = {
        Id: mockContainerId,
        Names: [`/${mockSandboxId}`],
        Image: 'mock-vercel-sandbox:latest',
        ImageID: 'sha256:abc123',
        Command: '/bin/bash',
        Created: mockCreatedTimestamp,
        Ports: [],
        Labels: {
          'mock-vercel-sandbox': 'true',
          sandboxId: mockSandboxId,
          runtime: 'node22',
        },
        State: 'running',
        Status: 'Up',
        HostConfig: { NetworkMode: 'default' },
        NetworkSettings: { Networks: {} },
        Mounts: [],
      };

      beforeEach(() => {
        mockDocker.getContainer.mockReturnValue(mockContainer);
        mockContainer.getArchive.mockResolvedValue(new Readable());
        mockTarExtract({
          '.timeout_timestamp': String(
            (vi.getMockedSystemTime()!.getTime() + 2800) * 1000,
          ),
        });
      });

      it('should get a sandbox by id', async () => {
        mockDocker.listContainers.mockResolvedValue([mockContainerInfo]);

        const sandbox = await Sandbox.get({ sandboxId: mockSandboxId });

        expect(mockDocker.listContainers).toHaveBeenCalledWith({
          filters: {
            label: [`sandboxId=${mockSandboxId}`, 'mock-vercel-sandbox=true'],
          },
          abortSignal: undefined,
        });
        expect(sandbox.sandboxId).toBe(mockSandboxId);
        expect(sandbox.status).toBe('running');
        expect(sandbox.routes).toHaveLength(0);
      });

      it('should throw error when sandbox is not found', async () => {
        mockDocker.listContainers.mockResolvedValue([]);

        await expect(
          Sandbox.get({ sandboxId: mockSandboxId }),
        ).rejects.toThrow();
      });

      it('should build routes from container ports', async () => {
        const containerInfo = {
          ...mockContainerInfo,
          Ports: [
            {
              PrivatePort: 3000,
              PublicPort: 3000,
              Type: 'tcp',
              IP: '0.0.0.0',
            },
            {
              PrivatePort: 8080,
              PublicPort: 8080,
              Type: 'tcp',
              IP: '0.0.0.0',
            },
          ],
        };

        mockDocker.listContainers.mockResolvedValue([containerInfo]);

        const sandbox = await Sandbox.get({ sandboxId: mockSandboxId });

        expect(sandbox.routes).toHaveLength(2);
        expect(sandbox.routes[0].port).toBe(3000);
        expect(sandbox.routes[0].subdomain).toBe('localhost:3000');
        expect(sandbox.routes[0].url).toBe('http://localhost:3000');
        expect(sandbox.routes[1].port).toBe(8080);
        expect(sandbox.routes[1].subdomain).toBe('localhost:8080');
        expect(sandbox.routes[1].url).toBe('http://localhost:8080');
      });

      it('should read timeout from container file', async () => {
        mockDocker.listContainers.mockResolvedValue([mockContainerInfo]);

        const sandbox = await Sandbox.get({ sandboxId: mockSandboxId });

        expect(mockContainer.getArchive).toHaveBeenCalledWith({
          path: '/vercel/.timeout_timestamp',
          abortSignal: undefined,
        });
        expect(sandbox.sandboxId).toBe(mockSandboxId);
        expect(sandbox.status).toBe('running');
        expect(sandbox.timeout).toBe(2800000);
      });
    });
  });
});

/**
 * Mock tar.extract() to emit entries for the given files.
 * @param files - Object mapping file paths to their string content.
 * @returns A Readable stream that can be used as the archive stream.
 */
function mockTarExtract(files: Record<string, string>) {
  vi.mocked(tar.extract).mockImplementation(() => {
    const extractEmitter = new EventEmitter();

    // Simulate tar-stream processing: emit entries for each file
    setImmediate(() => {
      const fileEntries = Object.entries(files);
      let entryIndex = 0;

      const emitNextEntry = () => {
        if (entryIndex >= fileEntries.length) {
          extractEmitter.emit('finish');
          return;
        }

        const [path, content] = fileEntries[entryIndex];
        entryIndex++;

        const entryStream = new Readable({
          read() {
            this.push(Buffer.from(content));
            this.push(null);
          },
        });

        extractEmitter.emit(
          'entry',
          { name: path },
          entryStream,
          emitNextEntry,
        );
      };

      emitNextEntry();
    });

    return extractEmitter as tar.Extract;
  });
}
