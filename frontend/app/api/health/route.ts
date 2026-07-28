export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(): Response {
  return Response.json(
    { status: "ok", service: "frontend" },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
