import { Sandbox } from '@vercel/sandbox';
import { config } from 'dotenv';

config({
  path: ['.env.local', '.env.development.local'],
  quiet: true,
});

const sandboxes = await Sandbox.list({
  projectId: process.env.VERCEL_PROJECT_ID!,
  teamId: process.env.VERCEL_TEAM_ID,
  token: process.env.VERCEL_OIDC_TOKEN,
  limit: 0,
});

console.log(sandboxes.text);
