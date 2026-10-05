import { NextResponse } from 'next/server';
export async function GET(){
 const key=process.env.VESSELFINDER_API_KEY;
 return NextResponse.json({connected:Boolean(key),source:'VesselFinder AIS',sourceUrl:'https://www.vesselfinder.com/realtime-ais-data',message:key?'AIS provider configured; add vessel IMO/MMSI in .env.local.':'Add VESSELFINDER_API_KEY plus IMO/MMSI values to enable live vessel positions.'});
}
