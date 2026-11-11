import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: '.env.local' });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  WH24_MODE: z.enum(['fake', 'http']).default('fake'),
  WH24_BASE_URL: z.string().default(''),
  WH24_CLIENT_ID: z.string().optional(),
  WH24_CLIENT_SECRET: z.string().optional(),
  WH24_GRANT_TYPE: z.string().default('client_credentials'),
  WH24_TENANT_ID: z.string().default(''),
  WH24_WF01_ID: z.string().default(''),
  WH24_WF02_ID: z.string().default(''),
  WH24_VIEW_FINANCE_USERS: z.string().default(''),
  WH24_VIEW_INSURER_USERS: z.string().default(''),
  WH24_VIEW_INSURERS: z.string().default(''),
  WH24_VIEW_FINANCE_PARTNERS: z.string().default(''),
  WH24_VIEW_PACKAGES: z.string().default(''),
  WH24_VIEW_VEHICLE_CATEGORIES: z.string().default(''),
  WH24_VIEW_TASKS: z.string().default(''),
  MOCK_INSURER_KEY: z.string().default('change-me'),
  WEBFORM_BASE_URL: z.string().default('http://localhost:5173'),
  BACKEND_PUBLIC_URL: z.string().default('http://localhost:4000')
});

export const config = envSchema.parse(process.env);
