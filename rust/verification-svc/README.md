# verification-svc 

Initial prototype exposing `constellation verify` to a web service to report
cluster verification to other properties. This is a part of evaluating Constellation and how to expose external verification of a cluster, will most likely be significantly reworked, and should *not* be trusted as anything beyond a demo.

## Usage

Run providing a path to a directory containing `constellation-state.yaml` and `constellation-conf.yaml`, ensuring `constellation` is installed and configured:

```sh
$ verification-svc /path/to/constellation_dir
```

```sh
$ curl http://localhost:30125/api/v0/verify
{"success":true}
```