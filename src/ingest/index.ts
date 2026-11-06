import {handleIngest} from './handler.ts'

declare const Deno: {
  env: {get(name: string): string | undefined}
  serve(handler: (request: Request) => Promise<Response>): void
}

Deno.serve(request =>
  handleIngest(request, {
    token: Deno.env.get('DEVSIGNAL_INGEST_TOKEN') ?? '',
    projectUrl: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  }),
)
