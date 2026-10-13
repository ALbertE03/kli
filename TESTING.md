# KLI - Agentic Coding Harness

[![CI](https://github.com/kli-org/kli/actions/workflows/ci.yml/badge.svg)](https://github.com/kli-org/kli/actions/workflows/ci.yml)

## Testing

```bash
# Run all tests
pnpm test

# Run unit tests
pnpm test:unit

# Run integration tests
pnpm test:int

# Run benchmark
pnpm test:benchmark
```

## Benchmark Suite

The benchmark suite tests 20 tasks with known solutions across different modes:

| Task | Mode | Expected |
|------|------|----------|
| Add fibonacci function | build | File created with tests passing |
| Explain auth module | ask | Correct symbol citations |
| Plan API refactor | plan | Numbered plan output |

Run benchmark:
```bash
pnpm test:benchmark
```

Outputs pass@1 and cost per task metrics.
