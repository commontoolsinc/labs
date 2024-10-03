# Planning Server

A simple `deno` server that exposes an API to interact with LLMs.

It supports tool calling collaboratively between the client and server, with the client providing a set of tools to the server in addition to the server's inbuilt toolkit.

This enables AI collaboration via standard function calls in the frontend application.

## Start

`npm run start`

## Configure `.env`

Create a `.env` file in the root of the project (copying `.env.local`) and substitute the values with your own.

## Memory Cache

The server retains a lookup of all threads since startup _and_ will cache responses for identical system + message pairs it encounters. **This is not fit for deployment.**

## Create Client

```ts
import { LLMClient } from "@commontools/llm-client";
const client = new LLMClient({
	serverUrl: "http://localhost:8000", // Assumes default port
	tools: [
		// These are the tools the _client_ is making available to the server
		{
			name: "calculator",
			input_schema: {
				type: "object",
				properties: {
					expression: {
						type: "string",
						description: "A mathematical expression to evaluate",
					},
				},
				required: ["expression"],
			},
			implementation: async ({ expression }) => {
				return `${await eval(expression)}`;
			},
		},
	],
	system: "use your tools to answer the request",
});
```

## Create a Thread

```ts
const thread = await client.createThread("what is 2+2*3?");

console.log(thread.conversation[1]);
// Tool called: calculator (2+2*3)
// Tool result: 8
// Assistant: The answer is 8
```

## Append to Thread

```ts
const thread = await client.createThread(
	"can you exaggerate this: I am having a _day_"
);

await client.continueThread(thread.id, "I am having a _great_ day");
```

## Continuous Integration (CI)

This project uses GitHub Actions for continuous integration. The CI pipeline is defined in `.github/workflows/planning-server.yml` and includes the following steps:

1. **Setup**: Prepares the environment and sets up variables.
2. **Build**: Compiles the Deno entrypoint for multiple target architectures (Linux x86_64/aarch64, Windows x86_64, macOS x86_64/aarch64).
3. **Lint**: Runs `deno lint` to check for code quality issues.
4. **Format**: Verifies code formatting using `deno fmt --check`.
5. **Test**: Executes tests using `deno test` and generates a coverage report.
6. **Docker Test**: Builds and tests the Docker image locally.
7. **Docker Push**: If on the main branch or manually triggered, builds and pushes the Docker image to Docker Hub.

The CI pipeline runs on pushes to the `main` branch and on pull requests that modify files in the `typescript/packages/planning-server/` directory or the workflow file itself.

### CI Artifacts

The following artifacts are generated during the CI process:

- Compiled binaries for different architectures
- Test coverage report
- Docker image

### Docker Image

The Docker image is built using a multi-stage process and is pushed to Docker Hub with the following tags:

- `latest`
- A short commit hash (e.g., `abcdef123456`)

The image is built for both `linux/amd64` and `linux/arm64` platforms.

## Deployment

The Planning Server can be deployed to a Kubernetes cluster using the provided Terraform configurations. The deployment process uses the Kubernetes provider for Terraform and includes options for Tailscale integration.

### Deployment Configuration

The deployment is managed by two main components in the [`infrastructure`](https://github.com/commontoolsinc/infrastructure) repo.

1. `KubernetesStack`: Handles the overall Kubernetes configuration.
2. `KubernetesTcpService`: Sets up the specific service for the Planning Server.

#### KubernetesTcpService Configuration

The `KubernetesTcpService` can be configured with the following options:

- `applicationName`: Name of the application (e.g., "planning-server").
- `applicationVersion`: Version of the application to deploy.
- `containerImageUrl`: URL of the container image.
- `tcpPort`: Port number for the service.
- `containerCommand`: (Optional) Command to run in the container.
- `imagePullPolicy`: (Optional) Kubernetes image pull policy.
- `serviceAccountPrivateKey`: (Optional) Private key for the service account.
- `containerEnvironment`: (Optional) Environment variables for the container.
- `secrets`: (Optional) Key-value pairs of secrets to be created.
- `args`: (Optional) Arguments to pass to the container.
- `tailscaleAuthKey`: (Optional) Auth key for Tailscale integration.
- `blockExternalAccess`: (Optional) Boolean to block external access to the service.

### Deployment Process

1. The `KubernetesStack` sets up the basic Kubernetes configuration, including providers for Kubernetes, Helm, and Tailscale.

2. A `KubernetesTcpService` is created for the Planning Server, which:

   - Creates a new namespace for the service.
   - Sets up necessary secrets and service accounts.
   - Deploys a pod with the Planning Server container.
   - Creates a Kubernetes service to expose the pod.
   - Optionally sets up Tailscale integration for secure access.

3. If Tailscale integration is enabled:

   - A Tailscale container is added to the pod.
   - Necessary roles and role bindings are created for Tailscale operation.
   - The service can be configured to block external access.

4. The deployment process outputs several values, including:
   - Cluster IP
   - Load balancer address (if not Tailscale-only)
   - Tailscale device information (if Tailscale is enabled)
   - Ingress port

### Tailscale Integration

Tailscale integration provides secure, easy-to-manage access to your deployed Planning Server. When enabled:

- The Planning Server pod runs an additional Tailscale container.
- The Tailscale container is configured with the provided auth key.
- You can optionally block external access to the service by setting `blockExternalAccess` to true.

### Deployment Commands

The deployment of the Planning Server is currently not as automated as the other services.

When the `builder` and `runtime` services are built and pushed on the `system` repo `main` branch, a PR is automatically triggered on the `infrastructure` repo to update the digests for the images used to deploy the `builder` and `runtime` services.

For the Planning Server, docker images are built and pushed to Docker Hub automatically on the `main` branch.
In order to deploy the Planning Server, create a PR on the `infrastructure` repo to update the `planning-server` image digest in the `infrastructure/cdktf/versions.auto.tfvars.json` file.

The PR will trigger a workflow that performs a `speculative plan` of the changes and outputs the changes that will be applied.

Once the PR is merged, the `apply` workflow will be triggered and the changes will be applied to the Kubernetes cluster.

### Post-Deployment

After deployment, you can access your Planning Server using either:

- The load balancer IP (if not using Tailscale-only access)
- The Tailscale device name (if using Tailscale)

The specific address and port will be provided in the Terraform output.

The Planning Server includes a health check endpoint that responds to all `GET` requests with a `200 OK` status code.
