---
title: Binary Trees
description: Traversal orders, the universal recursion template, and the diameter, LCA and serialization problems that make up most tree interviews
difficulty: Core
tags: [binary-tree, recursion, traversal, dfs]
---

Binary trees are where recursion stops being an abstract idea and becomes the natural tool. Nearly every tree problem is a variation of "combine information from the left subtree and the right subtree at each node" — once that template is automatic, the hard part becomes identifying what exactly to combine.

## Terminology

A tree is a hierarchical structure of nodes connected by edges, with a single root and zero or more children hanging off each node — no cycles, and every node except the root has exactly one parent.

![A generic tree with a root and branching child nodes](notes/DSA/Trees/image-1.png)

| General tree term | Meaning |
|---|---|
| Root | The single topmost node with no parent |
| Parent / child | A node that owns a child; the child it owns |
| Sibling | Nodes that share the same parent |
| Leaf | A node with no children |
| Internal node | A node with at least one child |
| Subtree | A node together with all of its descendants |
| Degree | The number of children a node has |

A **binary tree** restricts degree to at most 2 per node, and gives the two children fixed roles — left and right — which is what makes the recursive "combine left and right" template possible in the first place.

| Binary-tree-specific term | Meaning |
|---|---|
| Depth of a node | Number of edges from the root to that node |
| Height of a node | Number of edges on the longest path from that node down to a leaf |
| Balanced | For every node, the heights of its left and right subtrees differ by at most 1 |
| Complete | Every level is fully filled except possibly the last, which fills left to right |
| Full | Every node has 0 or 2 children (never exactly 1) |
| Perfect | Full **and** every leaf is at the same depth |

```java
class TreeNode {
    int val;
    TreeNode left, right;
    TreeNode(int val) { this.val = val; }
}
```

![A binary tree where every node has at most a left and a right child](notes/DSA/Trees/image-2.png)

> [!KEY]
> Height and depth are measured in opposite directions: depth counts down from the root to a node, height counts up from a node to its deepest leaf. The root's height equals the tree's height; a leaf's depth can be anything, but a leaf's height is always 0.

## Traversals

```text
        1
       / \
      2   3
     / \
    4   5
```

| Traversal | Order | Result on the tree above | Typical use |
|---|---|---|---|
| Preorder | Root → Left → Right | 1, 2, 4, 5, 3 | Copy/serialize a tree, prefix expression |
| Inorder | Left → Root → Right | 4, 2, 5, 1, 3 | Sorted output **for a BST** |
| Postorder | Left → Right → Root | 4, 5, 2, 3, 1 | Delete/free a tree, postfix expression |
| Level-order | Breadth-first, level by level | 1, 2, 3, 4, 5 | Shortest structural distance, tree width |

```mermaid
flowchart TD
    N1["1"] --> N2["2"] --> N4["4"]
    N2 --> N5["5"]
    N1 --> N3["3"]
```

```java
// Recursive inorder — O(n) time, O(h) space (call stack), h = tree height
void inorder(TreeNode node, List<Integer> result) {
    if (node == null) return;
    inorder(node.left, result);
    result.add(node.val);
    inorder(node.right, result);
}

// Iterative inorder — same complexity, explicit stack instead of recursion
List<Integer> inorderIterative(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    Deque<TreeNode> stack = new ArrayDeque<>();
    TreeNode cur = root;
    while (cur != null || !stack.isEmpty()) {
        while (cur != null) { stack.push(cur); cur = cur.left; }
        cur = stack.pop();
        result.add(cur.val);
        cur = cur.right;
    }
    return result;
}

// Level-order — BFS with a queue, O(n) time, O(w) space, w = max width
List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> levels = new ArrayList<>();
    if (root == null) return levels;
    Deque<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    while (!queue.isEmpty()) {
        int size = queue.size();
        List<Integer> level = new ArrayList<>();
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            level.add(node.val);
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        levels.add(level);
    }
    return levels;
}
```

> [!TIP]
> Recognise the traversal from the question's shape: "process children before the node" → postorder (deletion, bottom-up aggregation). "Process the node before children" → preorder (copying, top-down decisions). "Level by level" → BFS with a queue, not recursion.

## The recursion template for tree problems

The vast majority of tree DFS problems fit one shape: define what a call returns for a subtree, recurse on both children, then combine.

```java
ReturnType solve(TreeNode node) {
    if (node == null) return /* base case for an empty subtree */;
    ReturnType left = solve(node.left);
    ReturnType right = solve(node.right);
    return /* combine left, right, and node.val */;
}
```

```mermaid
flowchart TD
    P["solve(node)"] --> L["solve(node.left)"]
    P --> R["solve(node.right)"]
    L --> C["Combine left, right, node.val"]
    R --> C
```

The entire skill of tree problems is deciding **what to return** and **how to combine**. Height returns an int and combines with `1 + max(left, right)`. Path sum returns a bool and combines with OR. Diameter needs to return height *while separately tracking* a running maximum — which is why it commonly uses an instance field or a tuple return.

> [!WARNING]
> If a subtree's local answer isn't enough to compute the parent's answer (e.g., diameter needs height for combination, but the final answer is a max over *all* nodes, not just the root), track the global answer in a captured instance field or a single-element `int[]` holder rather than trying to force everything through the return value.

## Diameter of a binary tree

The diameter is the longest path between any two nodes, measured in edges — and that path might not pass through the root.

```java
private int diameter = 0;
public int diameterOfBinaryTree(TreeNode root) {
    height(root);
    return diameter;
}
private int height(TreeNode node) {
    if (node == null) return 0;
    int left = height(node.left);
    int right = height(node.right);
    diameter = Math.max(diameter, left + right);   // path through this node
    return 1 + Math.max(left, right);
}
```

`O(n)` time, `O(h)` space — a single pass computes height everywhere while updating the running max, instead of the naive `O(n²)` "compute height at every node separately".

## Lowest common ancestor (LCA)

For a general binary tree (not a BST), LCA is found by searching both subtrees: if a node's left and right subtrees each contain one of the two targets, that node is the LCA.

```java
public TreeNode lowestCommonAncestor(TreeNode root, TreeNode p, TreeNode q) {
    if (root == null || root == p || root == q) return root;
    TreeNode left = lowestCommonAncestor(root.left, p, q);
    TreeNode right = lowestCommonAncestor(root.right, p, q);
    if (left != null && right != null) return root;   // p and q split across subtrees
    return left != null ? left : right;               // both on one side (or not found)
}
```

`O(n)` time, `O(h)` space. For a **BST**, this simplifies to `O(h)` time with no need to search both sides: at each node, if both targets are smaller, go left; if both larger, go right; otherwise the current node is the LCA.

## Binary search trees, AVL trees and B-trees at a glance

A **binary search tree (BST)** is a binary tree with one extra rule: every node's left subtree holds only smaller values and its right subtree holds only larger ones — which is exactly why inorder traversal produces sorted output, and why BST search/insert both run in `O(h)` by discarding half the remaining nodes at each step.

![A binary search tree with smaller values to the left and larger to the right](notes/DSA/Trees/image-3.png)

Left unmanaged, a BST can degenerate into a linked-list shape on sorted input, pushing `h` from `O(log n)` to `O(n)`. Self-balancing trees fix this by restoring balance after every insert/delete: an **AVL tree** tracks a balance factor (`height(left) − height(right)`) at every node and applies rotations the moment that factor leaves `{-1, 0, 1}`.

![An AVL tree rebalanced with rotations after an insert](notes/DSA/Trees/image-4.png)

A **B-tree** generalises the same balancing idea from 2 children per node to `m` children, keeping every leaf at the same depth — the shape that makes it the standard structure for on-disk indexes, where minimising the number of disk reads (tree height) matters more than minimising comparisons.

| Aspect | AVL tree | Red-black tree | B-tree |
|---|---|---|---|
| Balance condition | Height diff ≤ 1 at every node | Longest path ≤ 2× shortest path | All leaves at the same depth |
| Lookup | `O(log n)`, fewer levels | `O(log n)` | `O(log_m n)`, very shallow |
| Insert/delete cost | More rotations (strict balance) | Fewer rotations | Node split/merge, not rotation |
| Disk/block storage | Poor — nodes are small | Poor | Designed for it — high fanout per block |
| Typical use | In-memory sorted maps, read-heavy | `TreeMap`, `std::map`, Linux CFS scheduler | Database indexes, filesystems |

> [!NOTE]
> The takeaway is structural: a BST is a binary tree plus an ordering rule, and AVL, red-black and B-trees are three different ways of bounding height so `O(log n)` actually holds. The important mechanics are the global subtree invariant, the successor/predecessor delete case, and rotations or high fanout to prevent degeneration.

## Path sum

"Does a root-to-leaf path sum to a target?" is a straightforward top-down DFS that subtracts as it descends:

```java
public boolean hasPathSum(TreeNode node, int target) {
    if (node == null) return false;
    if (node.left == null && node.right == null) return target == node.val;
    int remaining = target - node.val;
    return hasPathSum(node.left, remaining) || hasPathSum(node.right, remaining);
}
```

The harder variant — "sum of any path between any two nodes equals target" — needs a prefix-sum hash map carried down the recursion, similar to the subarray-sum-equals-k array pattern.

## Serialize and deserialize

Preorder with explicit null markers is the standard approach: it captures enough structural information to reconstruct the exact tree unambiguously.

```java
public String serialize(TreeNode root) {
    StringBuilder sb = new StringBuilder();
    serializeHelper(root, sb);
    return sb.toString();
}
private void serializeHelper(TreeNode node, StringBuilder sb) {
    if (node == null) { sb.append("#,"); return; }
    sb.append(node.val).append(',');
    serializeHelper(node.left, sb);
    serializeHelper(node.right, sb);
}

public TreeNode deserialize(String data) {
    Deque<String> tokens = new ArrayDeque<>(Arrays.asList(data.split(",")));
    return deserializeHelper(tokens);
}
private TreeNode deserializeHelper(Deque<String> tokens) {
    String token = tokens.poll();
    if (token.equals("#")) return null;
    TreeNode node = new TreeNode(Integer.parseInt(token));
    node.left = deserializeHelper(tokens);
    node.right = deserializeHelper(tokens);
    return node;
}
```

`O(n)` time and space both ways. Inorder alone can't reconstruct a tree uniquely (many shapes share the same inorder sequence) — you need preorder or postorder, which encode structure, not just BST value order.

## Tree DP intuition

"Tree DP" is just the recursion template with a richer return value — instead of one number, each call might return several: "best answer if this node is included" and "best answer if it's excluded", combined at the parent. The classic example is **house robber III**: at each node, decide to rob it (skip children, take grandchildren) or skip it (take the best of each child either way).

| Concept | Array DP | Tree DP |
|---|---|---|
| State | Index `i` | Node |
| Transition | `dp[i]` from `dp[i-1]`, `dp[i-2]`, ... | `solve(node)` from `solve(node.left)`, `solve(node.right)` |
| Order of evaluation | Left to right (or memoised) | Postorder (children before parent) |

## Cheat sheet

- Depth counts down from the root; height counts up from a leaf. The root's height is the tree's height.
- Preorder = copy/serialize, inorder = sorted order (BST only), postorder = delete/aggregate bottom-up, level-order = BFS with a queue.
- Recursion template: base case for null, recurse left and right, combine — the "combine" step is where the actual problem-solving happens.
- If the final answer isn't just the root's return value (diameter, max path sum), track it in a captured/instance variable while returning something narrower (height) for combination.
- LCA on a general tree needs to search both subtrees, `O(n)`; on a BST it's `O(h)` using value comparisons only.
- Serializing needs preorder/postorder plus explicit null markers — inorder alone loses structural information.
- Tree DP = the recursion template with a richer per-node return value (often "include" vs "exclude").
- A BST adds an ordering rule to a binary tree; AVL, red-black and B-trees are three different strategies for bounding its height at `O(log n)`.

## Common mistakes

| Mistake | Fix |
|---|---|
| Recomputing height at every node separately for diameter | Compute height once per node while updating a running max |
| Assuming inorder traversal alone can rebuild any binary tree | You need pre/postorder too, or explicit null markers |
| Using BST-style LCA logic on a general binary tree | General trees need to search both subtrees explicitly |
| Forgetting the null base case in recursive tree functions | Always handle `node == null` first |
| Confusing depth and height | Depth from root down; height from node/leaf up |
| Not considering recursion stack space in complexity | State `O(h)` space; call out worst case `O(n)` for a skewed tree |

## Summary

Binary tree problems are almost always the same recursive shape: handle the null case, recurse on both children, and combine their results with the current node's value. The skill interviewers are testing is picking the right "what to return" and "how to combine" — height for diameter, boolean for path existence, a pair of values for include/exclude tree DP. Learn the four traversal orders and when each applies, keep depth/height straight, and remember that a genuinely global answer (diameter, max path sum) usually needs a variable captured outside the recursive return value.

## Top Interview Questions

### Q1. What's the difference between depth and height of a node, and how do they relate to a "balanced" tree?

Depth is measured from the root down to a specific node — the root has depth 0, its children depth 1, and so on. Height is measured from a node up to its deepest descendant leaf — a leaf has height 0, and the tree's overall height is the height of the root. A tree is balanced when, for every node, the heights of its left and right subtrees differ by at most 1; this guarantees the overall height stays `O(log n)` rather than degrading toward `O(n)` for a skewed tree, which matters because most tree operations run in time proportional to height.

### Q2. Walk through the four standard tree traversals and when you'd use each.

Preorder (root, left, right) visits a node before its children, which is useful for copying or serializing a tree top-down, since you can reconstruct structure by knowing a node before its subtrees. Inorder (left, root, right) visits a node between its children, and for a binary search tree specifically produces values in sorted order — it's not meaningful as "sorted" for a general binary tree. Postorder (left, right, root) visits a node after its children, which is essential whenever a computation depends on the children's results first, like safely deleting a tree bottom-up or computing subtree aggregates. Level-order is breadth-first rather than depth-first, implemented with a queue rather than recursion, and is used whenever you need to process nodes by their distance from the root, such as finding the tree's maximum width or its minimum depth.

### Q3. How would you compute the diameter of a binary tree, and why is a naive approach O(n²)?

The diameter is the longest path between any two nodes, measured in edges, and that path doesn't necessarily pass through the root. A naive approach computes the height of the left and right subtree at every single node independently to find the longest path through that node, then takes the max over all nodes — but recomputing height from scratch at every node makes this `O(n)` work per node, `O(n²)` overall. The efficient approach computes height and updates a running "best diameter so far" in the *same* single postorder pass: at each node, compute left height and right height via recursive calls (which are needed anyway to return this node's own height), and update a captured global/instance variable with `left + right` as a candidate diameter. This reduces the whole computation to a single `O(n)` pass.

### Q4. How do you find the lowest common ancestor of two nodes in a general binary tree versus a binary search tree?

In a general binary tree, recursively search both subtrees for `p` and `q`: if the current node is null or matches either target, return it up; otherwise, recurse into both children. If both the left and right recursive calls return non-null, the current node is where `p` and `q` diverge — the LCA. If only one side returns non-null, propagate that result upward. This is `O(n)` time since you may need to visit every node. In a BST, you can skip the search entirely and use value comparisons: if both `p.val` and `q.val` are less than the current node, go left; if both greater, go right; otherwise (one is ≤ current ≤ the other, or one equals the current node), the current node is the LCA. This exploits the BST ordering invariant to run in `O(h)` time, visiting only one root-to-target path instead of the whole tree.

### Q5. Why can't you reconstruct a unique binary tree from its inorder traversal alone, and what do you need instead?

Inorder traversal only encodes the relative left-to-right ordering of values; it says nothing about which nodes are parents versus children or how deep any node sits, so many differently-shaped trees can share the identical inorder sequence. You need to pair inorder with either preorder or postorder — both of which encode the *root* explicitly at each recursive step (first element for preorder, last for postorder) — so you can identify the root, split the inorder sequence into left and right subtree portions around that root's position, and recurse. Alternatively, for serialization purposes specifically, a single preorder (or level-order) traversal augmented with explicit "null" markers for missing children is sufficient on its own to reconstruct the exact tree, without needing a second traversal at all.

### Q6. How would you check whether two binary trees are structurally identical, including values?

Recursively: two trees are identical if both roots are null (base case, trivially equal), or both roots are non-null with equal values and their left subtrees are recursively identical and their right subtrees are recursively identical. If one root is null and the other isn't, or the values differ, they're not identical — short-circuit and return false immediately. This is `O(min(n, m))` time in practice since it stops at the first mismatch, and `O(h)` space for the recursion stack. A common follow-up is checking if one tree is a *subtree* of another, which adds an outer loop trying this identical-check rooted at every node of the larger tree, giving `O(n * m)` in the naive case (improvable with string serialization plus substring search or hashing).

### Q7. Given a very large, deeply skewed binary tree, what problem might a naive recursive traversal hit in production, and how would you fix it?

A binary tree that's effectively a linked list (each node has only one child, consistently) has height `O(n)`, so a recursive traversal's call stack also grows to `O(n)` — for a tree with hundreds of thousands or millions of nodes, this can exceed the JVM's default thread stack (roughly 512KB–1MB, tunable with `-Xss`) and throw a `StackOverflowError`; the JVM technically lets you catch it, but recovering safely mid-traversal is fraught, so it's effectively fatal. The fix is to convert the recursive traversal to an iterative one using an explicit heap-allocated stack (an `ArrayDeque<TreeNode>` used as a stack), which has effectively no depth limit beyond available memory, instead of the fixed-size call stack. This is a good example of why "the recursive version is elegant" isn't the whole story in production code operating on untrusted or unbounded-depth data.

### Q8. Explain the general shape of a "tree DP" problem, using House Robber III (can't rob two directly-connected nodes) as an example.

Tree DP extends the standard recursion template by returning more than one value per subtree instead of a single aggregate: for House Robber III, each recursive call on a node returns a pair — the best total if this node *is* robbed, and the best total if it is *not*. If the node is robbed, its children cannot be, so that value is `node.val + child1.notRobbed + child2.notRobbed`. If the node is not robbed, each child is free to be robbed or not, so you take `Math.max(child.robbed, child.notRobbed)` for each child and sum them. The final answer is the max of the root's two returned values. This is exactly the array-DP idea of "state at position i depends on states at i-1/i-2" translated onto a tree, evaluated postorder (children resolved before the parent needs them).

### Q9. How would you serialize and deserialize a binary tree so it can be stored and reconstructed exactly?

Use a preorder traversal and explicitly emit a marker (like `#`) for null children, so the string captures the tree's shape as well as its values — for example, `"1,2,#,#,3,4,#,#,5,#,#"` for a small tree. To deserialize, split the string into tokens and consume them in the same preorder sequence: read a token, and if it's the null marker, return null; otherwise create a node with that value and recursively build its left and right children by continuing to consume tokens from the same stream. Because both serialize and deserialize walk the tokens in the exact same deterministic order, this round-trips any binary tree shape exactly, in `O(n)` time and space in both directions.

### Q10. What's the difference between a full, complete, and perfect binary tree, and why would this distinction matter in an interview?

A full binary tree requires every node to have either 0 or 2 children, never exactly 1. A complete binary tree requires every level to be fully filled except possibly the last, which must fill from left to right with no gaps — this is the shape a binary heap always maintains, which is precisely why a heap can be stored compactly in an array using index arithmetic instead of pointers. A perfect binary tree is both full and has every leaf at the same depth, giving exactly `2^(h+1) - 1` nodes for height `h`. The distinction matters practically because "complete" is the specific guarantee that makes array-based heap storage valid and efficient — if an interviewer asks why a heap can be an array, "because it's always a complete binary tree" is the precise, correct answer.

### Q11. Why would a database index use a B-tree instead of an AVL or red-black tree?

All three keep height logarithmic, but they optimise for different costs. AVL and red-black trees are binary — each node holds one key and two children — so descending them means one comparison per pointer-chase, which is cheap in memory but expensive on disk, where each pointer-chase can mean a separate disk read. A B-tree instead packs many keys and children (often hundreds) into a single node sized to match a disk page, so one disk read lets you eliminate a large fraction of the remaining keys at once rather than just one. This makes a B-tree's height, and therefore the number of disk reads for a lookup, dramatically smaller than an equivalent binary tree over the same key count — which is exactly the cost that matters for on-disk indexes, so B-trees (and B+trees) are the standard choice for database and filesystem indexes, while AVL/red-black trees stay the standard for in-memory sorted structures.
