import path from 'node:path';
import { start } from '@galaxy/common/electron/main';
import { registerApiImpl } from './impl/register';

start('orbit', { preload: path.join(__dirname, 'preload.js'), implementations: registerApiImpl() });
