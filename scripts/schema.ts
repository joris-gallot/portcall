import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import { configSchema } from '../src/config.ts'

const schema = { ...z.toJSONSchema(configSchema), title: 'portcall.json' }
writeFileSync(new URL('../schema.json', import.meta.url), `${JSON.stringify(schema, null, 2)}\n`)
