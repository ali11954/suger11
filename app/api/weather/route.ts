import { NextResponse } from 'next/server';
export async function GET(){
 const lat=Number(process.env.WEATHER_LAT??-23.96), lon=Number(process.env.WEATHER_LON??-46.33);
 const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,wind_speed_10m&hourly=precipitation_probability&forecast_days=5&timezone=auto`;
 try{const r=await fetch(url,{cache:'no-store'});const j=await r.json();return NextResponse.json({source:'Open-Meteo',sourceUrl:'https://open-meteo.com/',current:j.current??null,hourly:j.hourly??null});}catch{return NextResponse.json({source:'Open-Meteo',current:null,hourly:null},{status:200});}
}
