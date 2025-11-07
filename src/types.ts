/**
 * Type definitions re-exported from Vercel Sandbox SDK.
 *
 * This file provides a centralized place to import types from the Vercel Sandbox SDK,
 * ensuring type compatibility and avoiding duplication.
 */

import type { Sandbox as VercelSandbox } from '@vercel/sandbox';
import type {
  CommandData,
  SandboxMetaData,
  SandboxRouteData,
} from '@vercel/sandbox/dist/api-client';
import type { Signal } from '@vercel/sandbox/dist/utils/resolveSignal';

// Re-export types from Vercel SDK
export type { CommandData, SandboxMetaData, SandboxRouteData, Signal };

// Extract parameter types from Vercel Sandbox class
export type CreateSandboxParams = NonNullable<
  Parameters<typeof VercelSandbox.create>[0]
> & { rebuild?: boolean };
export type GetSandboxParams = Parameters<typeof VercelSandbox.get>[0];
export type RunCommandParams = NonNullable<
  Parameters<InstanceType<typeof VercelSandbox>['_runCommand']>[0]
>;

// Derived types
export type SandboxStatus = SandboxMetaData['status'];
export type SandboxSource = NonNullable<CreateSandboxParams['source']>;
