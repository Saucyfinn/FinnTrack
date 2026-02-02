export async function onRequestPost(context) {
  const { request } = context;
  const url = new URL(request.url);
  
  const deviceKey = url.searchParams.get('deviceKey');
  const raceId = url.searchParams.get('raceId');
  
  const data = await request.text();
  const params = new URLSearchParams(data);
  
  const locationData = {
    deviceKey,
    raceId,
    lat: params.get('lat'),
    lon: params.get('lon'),
    speed: params.get('speed'),
    bearing: params.get('bearing'),
    timestamp: new Date().toISOString()
  };
  
  console.log('Location received:', locationData);
  
  return new Response('OK', { status: 200 });
}