import { app, InvocationContext, Timer } from "@azure/functions";

export async function autoCloseShiftTimer(myTimer: Timer, context: InvocationContext): Promise<void> {
    context.log('Timer function processed request.');
}

app.timer('autoCloseShiftTimer', {
    schedule: '*/5 * * * * *',
    handler: autoCloseShiftTimer
});
