---
title: Matrices and Simulation
description: Direction-vector traversal, in-place rotation and zeroing, spiral order, flood fill, and the index arithmetic that connects 1-D and 2-D representations
difficulty: Core
tags: [matrix, simulation, arrays]
---

Matrix problems are rarely about a clever algorithm — they are about careful index bookkeeping: which direction you're walking, which boundary you've hit, and whether you can avoid an extra `O(rows·cols)` buffer. Interviewers use them to see whether your code is correct on the first try, not just eventually.

## Row/column traversal and the direction-vector technique

Most grid problems (flood fill, number of islands, rotting oranges, word search) move in four directions. Encoding directions as an array of `(dr, dc)` pairs avoids four copy-pasted if-blocks and is the single most reusable idiom in this topic.

```java
// Direction vectors: up, down, left, right
int[][] dirs = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
for (int[] d : dirs) {
    int nr = r + d[0], nc = c + d[1];
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited[nr][nc]) {
        // process (nr, nc)
    }
}
```

```mermaid
flowchart LR
    C["Current cell (r, c)"] --> U["Up: (r-1, c)"]
    C --> D["Down: (r+1, c)"]
    C --> L["Left: (r, c-1)"]
    C --> R["Right: (r, c+1)"]
```

> [!KEY]
> Always bounds-check **before** indexing, not after: `nr >= 0 && nr < rows && nc >= 0 && nc < cols` must short-circuit before touching `grid[nr][nc]`, or you risk an `ArrayIndexOutOfBoundsException` on the boundary.

## Spiral order

Track four shrinking boundaries — `top`, `bottom`, `left`, `right` — and walk each side in turn, shrinking the relevant boundary after each side. The two "if" guards before the final two sides handle single-row/single-column remainders correctly.

```java
// O(rows * cols) time, O(1) extra space excluding the output
public List<Integer> spiralOrder(int[][] matrix) {
    List<Integer> result = new ArrayList<>();
    int top = 0, bottom = matrix.length - 1, left = 0, right = matrix[0].length - 1;
    while (top <= bottom && left <= right) {
        for (int j = left; j <= right; j++) result.add(matrix[top][j]);
        top++;
        for (int i = top; i <= bottom; i++) result.add(matrix[i][right]);
        right--;
        if (top <= bottom) {                       // guard: a row remains
            for (int j = right; j >= left; j--) result.add(matrix[bottom][j]);
            bottom--;
        }
        if (left <= right) {                        // guard: a column remains
            for (int i = bottom; i >= top; i--) result.add(matrix[i][left]);
            left++;
        }
    }
    return result;
}
```

> [!WARNING]
> Skipping the two guard checks (`if (top <= bottom)`, `if (left <= right)`) causes the last row or column to be visited **twice** when the matrix isn't square — a classic bug that only shows up on non-square test cases.

## Rotate image in place

Rotating a square matrix 90° clockwise decomposes into two simpler, well-known operations: **transpose**, then **reverse each row**.

```java
// O(n^2) time, O(1) extra space
public void rotate(int[][] matrix) {
    int n = matrix.length;
    for (int i = 0; i < n; i++)                 // transpose
        for (int j = i + 1; j < n; j++) {
            int t = matrix[i][j]; matrix[i][j] = matrix[j][i]; matrix[j][i] = t;
        }
    for (int[] row : matrix)                     // reverse each row
        for (int lo = 0, hi = n - 1; lo < hi; lo++, hi--) {
            int t = row[lo]; row[lo] = row[hi]; row[hi] = t;
        }
}
```

| Rotation | Operations |
|---|---|
| 90° clockwise | Transpose, then reverse each row |
| 90° counter-clockwise | Transpose, then reverse each column (or reverse rows, then transpose) |
| 180° | Reverse each row, then reverse each column (or reverse rows top-bottom and reverse each row) |

## Set matrix zeroes with O(1) space

The naive solution marks zero positions in a separate `rows`/`cols` boolean set — `O(rows + cols)` space. The O(1) trick reuses the **first row and first column of the matrix itself** as that marker set, with two extra booleans to remember whether the first row/column originally contained a zero (since they get overwritten).

```java
// O(rows * cols) time, O(1) extra space
public void setZeroes(int[][] matrix) {
    int rows = matrix.length, cols = matrix[0].length;
    boolean firstRowZero = false, firstColZero = false;
    for (int j = 0; j < cols; j++) if (matrix[0][j] == 0) firstRowZero = true;
    for (int i = 0; i < rows; i++) if (matrix[i][0] == 0) firstColZero = true;

    for (int i = 1; i < rows; i++)
        for (int j = 1; j < cols; j++)
            if (matrix[i][j] == 0) { matrix[i][0] = 0; matrix[0][j] = 0; }

    for (int i = 1; i < rows; i++)
        for (int j = 1; j < cols; j++)
            if (matrix[i][0] == 0 || matrix[0][j] == 0) matrix[i][j] = 0;

    if (firstRowZero) for (int j = 0; j < cols; j++) matrix[0][j] = 0;
    if (firstColZero) for (int i = 0; i < rows; i++) matrix[i][0] = 0;
}
```

> [!TIP]
> Narrate the trade-off: *"Naive is O(rows + cols) space with two marker sets. I can reuse the first row and column as markers instead, dropping to O(1) — but I need two booleans to remember whether the first row/column themselves originally had a zero, since I'm about to overwrite them."*

## Transpose and index arithmetic between 1-D and 2-D

A transpose swaps `matrix[i][j]` with `matrix[j][i]`; for a non-square matrix this must write into a **new** `cols x rows` array since the dimensions themselves swap. When a matrix is stored as a flat 1-D array (common in interviews to test index arithmetic directly), the conversions are:

| Conversion | Formula |
|---|---|
| 2-D `(r, c)` → 1-D index | `index = r * cols + c` |
| 1-D `index` → 2-D `(r, c)` | `r = index / cols`, `c = index % cols` |
| Row-major vs column-major | Row-major (Java, C, C++): rows are contiguous. Column-major (Fortran, MATLAB): columns are contiguous |

```java
// Binary search a fully row-major sorted matrix as if it were flat 1-D
int lo = 0, hi = rows * cols - 1;
while (lo <= hi) {
    int mid = lo + (hi - lo) / 2;
    int r = mid / cols, c = mid % cols;
    if (matrix[r][c] == target) return true;
    if (matrix[r][c] < target) lo = mid + 1; else hi = mid - 1;
}
```

## Flood fill and boundary checks

Flood fill (and its close relatives: number of islands, rotting oranges, walls and gates) is BFS or DFS from a seed cell, spreading to neighbours that satisfy a condition, marking visited cells so you don't reprocess them.

```java
// O(rows * cols) time and space (worst case, all cells match)
public void fill(int[][] image, int sr, int sc, int newColor) {
    int oldColor = image[sr][sc];
    if (oldColor == newColor) return;             // avoid infinite loop on same color
    dfs(image, sr, sc, oldColor, newColor);
}
private void dfs(int[][] img, int r, int c, int oldColor, int newColor) {
    if (r < 0 || r >= img.length || c < 0 || c >= img[0].length || img[r][c] != oldColor)
        return;
    img[r][c] = newColor;
    dfs(img, r + 1, c, oldColor, newColor);
    dfs(img, r - 1, c, oldColor, newColor);
    dfs(img, r, c + 1, oldColor, newColor);
    dfs(img, r, c - 1, oldColor, newColor);
}
```

> [!DANGER]
> If `newColor == oldColor`, a naive flood fill recurses forever, repainting a cell to the same color and re-triggering on its neighbours. Guard against this before recursing, not inside the base case.

## Game of Life in place

The trick for updating every cell **simultaneously** without a second buffer: encode both the old and new state in the same cell using extra bit values, then do a second pass to collapse them to final `0`/`1`.

```java
// O(rows * cols) time, O(1) extra space
// Encoding uses bit 0 as the old state and bit 1 as the new state:
// 0 = dead->dead, 1 = live->dead, 2 = dead->live, 3 = live->live
for (int r = 0; r < rows; r++)
    for (int c = 0; c < cols; c++) {
        int liveNeighbors = countLiveNeighbors(board, r, c);  // reads only original bit (board[i][j] & 1)
        if ((board[r][c] & 1) == 1 && (liveNeighbors == 2 || liveNeighbors == 3))
            board[r][c] = 3;                       // live -> live
        if ((board[r][c] & 1) == 0 && liveNeighbors == 3)
            board[r][c] = 2;                       // dead -> live
    }
for (int r = 0; r < rows; r++)
    for (int c = 0; c < cols; c++)
        board[r][c] >>= 1;                         // collapse to final state
```

## Comparison of matrix techniques

| Technique | Extra space | Used for |
|---|---|---|
| Direction vectors | `O(1)` | Any 4/8-directional grid traversal |
| Transpose + reverse rows | `O(1)` | In-place 90° rotation of a square matrix |
| First-row/column as markers | `O(1)` | Set matrix zeroes without a separate marker set |
| Bit-packing two states per cell | `O(1)` | Simultaneous whole-grid update (Game of Life) |
| BFS/DFS with a visited grid | `O(rows·cols)` | Flood fill, islands, shortest path on a grid |

## Mutability and representation choices

Before using an in-place trick, confirm the input may be mutated. Marking visited cells with a sentinel is elegant for flood fill and word search, but it is wrong if the caller expects the grid unchanged after the function returns; in that case, use a separate `visited` grid or restore every changed cell during backtracking. The same trade-off appears in Set Matrix Zeroes: reusing row 0 and column 0 is `O(1)` space, but it deliberately overwrites the matrix as scratch state.

Representation also changes performance and indexing. Java's `int[][]` is an array of row arrays, not one contiguous rectangular block, so `matrix.length` is the row count and each row technically has its own length. Interview grids are normally rectangular, but defensive production code should not assume `matrix[0].length` applies to every row unless the input contract says so. For flattening, the row-major formulas `index = r * cols + c` and `(r, c) = (index / cols, index % cols)` only preserve sorted order when the whole matrix is sorted in row-major order, not merely when each row and each column is independently sorted.

For BFS simulations such as rotting oranges or shortest path in a grid, process by layers when the answer is time or distance. Store the queue size at the start of each minute/level, expand exactly that many cells, then increment the time after the layer finishes. Incrementing time per cell instead of per layer is a subtle simulation bug in practice.

## Cheat sheet

- **Direction-vector arrays** replace four copy-pasted if-blocks with one loop — use them by default.
- **Bounds-check before indexing**, never after.
- **90° rotation = transpose + reverse rows.** Know the variant for counter-clockwise and 180°.
- **Set matrix zeroes O(1)** reuses row 0 / column 0 as the marker set; remember the two extra booleans.
- **1-D ↔ 2-D index math**: `index = r * cols + c`; `r = index / cols`, `c = index % cols`.
- **Flood fill needs an early return** when `newColor == oldColor`, or it recurses forever.
- **Game of Life in place** encodes old and new state in the same integer using extra bits, collapsed in a second pass.
- State whether the "output"/result array counts toward space complexity — usually it's excluded, but say so.

## Common mistakes

| Mistake | Fix |
|---|---|
| Indexing before bounds-checking | Put the range check first in a short-circuiting `&&` |
| Forgetting the two guards in spiral order for non-square matrices | Add `if (top <= bottom)` / `if (left <= right)` before the last two sides |
| Rotating counter-clockwise the same way as clockwise | Clockwise = transpose + reverse rows; counter-clockwise needs the mirrored sequence |
| Using a separate visited set when the grid itself can be mutated as a marker | Reuse row 0 / column 0, or overwrite visited cells with a sentinel, to save space |
| Missing the `newColor == oldColor` guard in flood fill | Check and return early before recursing |
| Reading already-updated neighbor state in Game of Life | Encode both old and new state per cell so reads during the pass see only the original |

## Summary

Matrix and simulation questions reward careful index discipline more than algorithmic insight: direction vectors simplify neighbour traversal, transpose-plus-reverse handles in-place rotation, and reusing part of the grid itself as scratch space (row 0/column 0, or extra bits per cell) turns an `O(n)`-space solution into `O(1)`. The recurring failure mode is an off-by-one or unguarded index at a boundary — bounds-check before indexing, guard non-square edge cases explicitly, and always ask whether you're allowed to mutate the input before assuming you need a second buffer.

## Top Interview Questions

### Q1. How do direction vectors simplify grid traversal code, and what's the standard pattern?

Instead of writing four (or eight) separate if-blocks to check up/down/left/right neighbours, store the row/column deltas as an array of pairs, e.g. `{(-1,0), (1,0), (0,-1), (0,1)}`, and loop over them, applying the same bounds-check-then-process logic to each. This collapses duplicated code into one loop, makes it trivial to extend to 8-directional movement by adding four diagonal pairs, and reduces the chance of a copy-paste bug where one direction's bounds check is subtly wrong. The pattern is: for each direction, compute the neighbour coordinate, bounds-check it, and only then read or write `grid[nr][nc]`.

### Q2. Walk through why transpose-then-reverse-rows correctly rotates a square matrix 90 degrees clockwise.

Transposing swaps `matrix[i][j]` with `matrix[j][i]`, which reflects the matrix across its main diagonal — this turns rows into columns. Reversing each row afterward flips the order of elements left-to-right within each new row. The combined effect moves what was the first column (top to bottom) into the first row (left to right reversed appropriately), which is exactly what a 90° clockwise rotation does: the leftmost column becomes the top row. You can verify this on a small 2x2 example by hand — `[[1,2],[3,4]]` transposes to `[[1,3],[2,4]]`, then reversing each row gives `[[3,1],[4,2]]`, which is indeed the original matrix rotated 90° clockwise.

### Q3. How would you rotate a matrix 90 degrees counter-clockwise in place, using the same building blocks?

You need the mirrored sequence: transpose the matrix, then reverse each **column** instead of each row (equivalently, reverse the order of the rows themselves before transposing, then transpose). Concretely: transpose first (swap `matrix[i][j]` with `matrix[j][i]`), then for each column, swap its top and bottom elements symmetrically (or just reverse the row array's *order*, i.e., swap `matrix[i]` with `matrix[n-1-i]` on the outer array of rows, applied before transposing, then transpose after). The key point to state out loud is that clockwise and counter-clockwise rotation both reduce to transpose plus a reversal, just applied to a different axis or in a different order.

### Q4. Explain the O(1) space trick for "set matrix zeroes" — why do you need two extra boolean variables?

Instead of allocating separate `O(rows)` and `O(cols)` boolean arrays to remember which rows/columns must be zeroed, you reuse the matrix's own first row and first column as that marker space — if `matrix[i][j] == 0`, mark `matrix[i][0] = 0` and `matrix[0][j] = 0`. The problem is that the first row and first column are now doing double duty: they hold both "was this originally a zero" and "should this row/column now become all zero". Since writing markers into `matrix[0][*]` and `matrix[*][0]` can overwrite their *original* zero-ness before you've finished scanning, you first check and store whether the first row and first column *originally* contained any zero in two separate booleans, apply the marker-based zeroing to the rest of the matrix, and only zero out the first row/column themselves at the very end based on those two booleans.

### Q5. Your flood-fill implementation is stack-overflowing on a large image with a solid single color — what's happening and how would you fix it?

Two possible causes: first, if `newColor` equals the color already at the seed cell, the recursion never terminates because every neighbour still matches "oldColor equals newColor" and keeps re-triggering — the fix is an early return when `newColor == oldColor` before any recursion begins. Second, even without that bug, a genuinely large solid-color region causes deep recursion (up to `rows * cols` stack frames in the worst case, e.g., a snake-like single-color path), which can exceed the call stack limit — the fix there is to convert the DFS to an explicit stack-based iterative version or a BFS with a queue, both of which use heap-allocated storage instead of the call stack and don't have the same depth limit.

### Q6. How do you convert between a flat 1-D array index and 2-D row/column coordinates, and where does this show up in interviews?

For a matrix with `cols` columns stored in row-major order, a 2-D coordinate `(r, c)` maps to flat index `r * cols + c`, and the reverse mapping is `r = index / cols`, `c = index % cols` (integer division and modulo). This shows up whenever a matrix is described as "if you read it as one sorted array" — like "search a 2D matrix" problems where each row is sorted and the first element of each row is greater than the last element of the previous row, letting you binary search the whole matrix as if it were flattened, computing `(r, c)` from the midpoint index on the fly instead of materializing a real 1-D array.

### Q7. What's the trick for updating every cell of a grid "simultaneously" in place, as in Conway's Game of Life?

The core problem is that updating cell `(i, j)` based on its neighbours must not be affected by neighbours that have *already* been updated in this same pass — but scanning row by row naturally updates some neighbours before others are processed. The fix is to encode both the old and new state in the same integer using extra bits: for instance, use bit 0 for the original state and bit 1 for the new state, so `board[i][j] & 1` always reads the *original* value regardless of what's been written to bit 1 so far, then do a second full pass afterward to right-shift every cell, collapsing to just the new state. This achieves an in-place, `O(1)`-extra-space update without a second grid.

### Q8. In spiral order traversal, why are the two "if" guards for the third and fourth sides necessary?

After processing the top row and right column, the boundaries `top` and `right` have already been shrunk. If the matrix isn't square, it's possible that by this point `top > bottom` (all rows exhausted) or `left > right` (all columns exhausted) — processing the bottom row or left column without checking this would either revisit already-visited cells or, in some implementations, read out of the now-invalid range. The guards `if (top <= bottom)` before the bottom-row pass and `if (left <= right)` before the left-column pass ensure you only process a side that genuinely still has unvisited cells, which specifically matters for single-row or single-column matrices where the shrinking boundaries cross earlier than expected.

### Q9. How would you find the number of distinct islands (not just count of islands) in a grid, and how does this differ from a plain flood fill?

Plain flood fill / island counting just needs to mark visited cells and increment a counter per connected component. To find *distinct* shapes, during each island's DFS/BFS, record the sequence of relative moves (or relative coordinates normalized against the starting cell of that island) as a canonical signature — e.g., a string like "D,D,R,U" representing the traversal path taken. Store these signatures in a `HashSet<String>`; two islands are the "same shape" if and only if their canonicalized signatures match, so the answer is the size of that set. This extends the basic flood-fill pattern by adding a normalization step that makes shape comparison independent of the island's absolute position in the grid.

### Q10. What's the time and space complexity of "search a 2D matrix" where each row and column is individually sorted (not fully sorted overall)?

Where rows and columns are each independently sorted (but the last element of a row isn't necessarily less than the first of the next row — a weaker guarantee than the fully-sorted variant), the standard technique starts at the top-right corner: if the current value is greater than the target, move left (eliminate that column); if smaller, move down (eliminate that row); if equal, found. Each step eliminates one row or one column, so the algorithm terminates in at most `rows + cols` steps, giving `O(rows + cols)` time and `O(1)` space — notably different from the fully-sorted variant, which supports a true `O(log(rows * cols))` binary search by treating the matrix as flattened.

### Q11. When would you choose BFS over DFS for a flood-fill-style grid problem, and does it affect correctness?

Both BFS and DFS visit the same *set* of reachable cells and are equally correct for plain flood fill or counting connected components — the choice doesn't change the result. It matters when the problem also asks for **shortest distance** from a seed (like "rotting oranges" — minutes until all oranges rot, or shortest path in a maze): BFS processes cells in increasing order of distance from the source, so the first time you reach a cell is guaranteed to be via the shortest path, which DFS does not guarantee. BFS also avoids the recursion-depth risk of DFS on very large grids, since it's naturally iterative with an explicit queue.

### Q12. How would you extend flood fill to support 8-directional connectivity instead of 4-directional, and where does this distinction actually matter?

Simply extend the direction-vector array from four entries (up/down/left/right) to eight, adding the four diagonals: `(-1,-1), (-1,1), (1,-1), (1,1)`. The rest of the BFS/DFS logic is unchanged. This distinction matters in practice for image-processing-style problems (is a diagonal touch enough to connect two regions of the same color?) and grid-based games — "number of islands" problems will explicitly state which connectivity rule applies, and using the wrong one silently produces a different (usually smaller, for 4-directional treated as 8) count of connected components without any runtime error, so it's worth confirming the connectivity rule before coding rather than assuming 4-directional by default.
