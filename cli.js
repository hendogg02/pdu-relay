import * as unifi from "./unifi-client.js";

const [, , command, ...args] = process.argv;

const commands = {
  async "pdu-list"() {
    console.log(JSON.stringify(await unifi.listPduDevices(), null, 2));
  },
  async "pdu-outlets"(id) {
    if (!id) throw new Error("Usage: pdu-outlets <pduId>");
    const device = await unifi.getPduDeviceById(id);
    console.log(JSON.stringify(unifi.listPduOutlets(device), null, 2));
  },
  async "pdu-cycle"(id, index) {
    if (!id || !index) throw new Error("Usage: pdu-cycle <pduId> <outletIndex>");
    await unifi.cyclePduOutlet(id, Number(index));
    console.log(`Outlet ${index} on ${id} cycled.`);
  },
};

const handler = commands[command];

if (!handler) {
  console.log(`Usage: node cli.js <command> [args]

Commands:
  pdu-list
  pdu-outlets <pduId>
  pdu-cycle <pduId> <outletIndex>
`);
  process.exit(command ? 1 : 0);
}

try {
  await handler(...args);
} catch (err) {
  console.error(err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
}
