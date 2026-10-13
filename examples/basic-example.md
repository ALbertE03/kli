# Example: Using KLI to add a fibonacci function

## Setup

```bash
# Create a test workspace
mkdir -p /tmp/kli-example/src
cd /tmp/kli-example

# Initialize KLI
kli plugin add @kli/tool-read-file
kli plugin add @kli/tool-create-file
kli plugin add @kli/tool-edit-file
kli plugin add @kli/backend-ts-morph
```

## Run a task

```bash
kli run --mode build "Add a fibonacci function to src/math.ts"
```

## Expected workflow

1. KLI reads the workspace and builds the code graph
2. The agent reads existing files to understand the codebase
3. Creates or edits `src/math.ts` with the fibonacci implementation
4. Runs tests to verify
5. Returns the result

## Example task outputs

### Plan mode
```bash
kli run --mode plan "Refactor auth module to use JWT"
```
Output: A numbered plan with steps like:
1. Read src/auth.ts to understand current implementation
2. Identify all token validation logic
3. Create src/jwt.ts with new implementation
4. Update src/auth.ts to use jwt module
5. Run tests to verify

### Build mode
```bash
kli run --mode build "Create a REST API endpoint for users"
```
The agent will:
- Read existing API structure
- Create the endpoint
- Add tests
- Verify everything passes

### Ask mode
```bash
kli run --mode ask "How does the authentication work?"
```
The agent will:
- Query the code graph
- Read relevant files
- Explain the authentication flow with symbol citations